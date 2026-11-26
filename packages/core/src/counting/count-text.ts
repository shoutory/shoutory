import { z } from "zod";

const codePoint = z.int().min(0).max(0x10ffff);

// The first range that holds a code point decides its weight, so overlap or disorder would make that depend on the order.
function isAscendingAndDisjoint(ranges: readonly { from: number; to: number }[]): boolean {
  return ranges.every(
    (range, index) => range.from <= range.to && (index === 0 || range.from > (ranges[index - 1]?.to ?? -1)),
  );
}

export const countingRuleSchema = z
  .strictObject({
    unit: z.enum(["graphemes", "utf16", "bytes", "weighted"]),
    urlWeight: z.int().positive().optional(),
    mentions: z.literal("local_part").optional(),
    weights: z
      .strictObject({
        defaultWeight: z.int().nonnegative(),
        ranges: z
          .array(z.strictObject({ from: codePoint, to: codePoint, weight: z.int().nonnegative() }))
          .max(256)
          .refine(isAscendingAndDisjoint, "ranges must end no earlier than they start, ascending and apart"),
      })
      .optional(),
  })
  .refine((rule) => rule.unit !== "weighted" || rule.weights !== undefined, {
    path: ["weights"],
    message: "a weighted rule needs weights",
  });

export type CountingRule = z.infer<typeof countingRuleSchema>;

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const encoder = new TextEncoder();
// A link may not follow a Latin letter, digit or one of `_@$#`, and its path ends where Arabic, CJK or a space begins.
const URL_PATTERN =
  /(?<![a-z0-9_@$#])https?:\/\/[^\s\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?\]}'"،؛؟]+$/u;

// A mention is `@name` with an optional `@domain` and does not follow a word character, `=` or `/`.
const MENTION_PATTERN =
  /(?<![=/\p{L}\p{N}_])@([a-z0-9_]+(?:[a-z0-9_.-]+[a-z0-9_]+)?)(?:@[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?/giu;

function countPlain(rule: CountingRule, text: string): number {
  const counted = rule.mentions === "local_part" ? text.replace(MENTION_PATTERN, "@$1") : text;
  return countSegment(rule, counted);
}

function occurrences(text: string, char: string): number {
  return text.split(char).length - 1;
}

function trimUrl(match: string): string {
  let url = match.replace(TRAILING_PUNCTUATION, "");
  while (url.endsWith(")") && occurrences(url, ")") > occurrences(url, "(")) {
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return url;
}

function countSegment(rule: CountingRule, text: string): number {
  switch (rule.unit) {
    case "utf16":
      return text.length;
    case "bytes":
      return encoder.encode(text).length;
    case "graphemes": {
      let count = 0;
      for (const _ of graphemes.segment(text)) count += 1;
      return count;
    }
    case "weighted": {
      const { defaultWeight, ranges } = rule.weights ?? { defaultWeight: 1, ranges: [] };
      let total = 0;
      for (const char of text) {
        const point = char.codePointAt(0) ?? 0;
        total += ranges.find((range) => point >= range.from && point <= range.to)?.weight ?? defaultWeight;
      }
      return total;
    }
  }
}

export function countText(rule: CountingRule, text: string): number {
  let total = 0;
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    const start = match.index;
    total += countPlain(rule, text.slice(cursor, start));
    total += rule.urlWeight ?? countSegment(rule, url);
    cursor = start + url.length;
  }
  return total + countPlain(rule, text.slice(cursor));
}
