import { z } from "zod";

const codePoint = z.int().min(0).max(0x10ffff);

// The first range that holds a code point decides its weight, so overlap or disorder would make that depend on the order.
function isAscendingAndDisjoint(ranges: readonly { from: number; to: number }[]): boolean {
  return ranges.every(
    (range, index) => range.from <= range.to && (index === 0 || range.from > (ranges[index - 1]?.to ?? -1)),
  );
}

/** Text-length rules as data: a provider manifest carries one, and `countText` is the only function that reads it. */
export const countingRuleSchema = z
  .strictObject({
    unit: z.enum(["graphemes", "utf16", "bytes", "weighted"]),
    urlWeight: z.int().positive().optional(),
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
const URL_PATTERN = /https?:\/\/\S+/giu;
// Punctuation that follows a link in prose and is not part of it (Latin and Arabic).
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"،؛؟]+$/u;

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

/**
 * The one counter for every length limit: the composer, admission and the adapter all call it with the same rule.
 * A link counts `urlWeight` whatever its length; a weighted rule weighs each code point by the first range that holds it.
 */
export function countText(rule: CountingRule, text: string): number {
  let total = 0;
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    const start = match.index;
    total += countSegment(rule, text.slice(cursor, start));
    total += rule.urlWeight ?? countSegment(rule, url);
    cursor = start + url.length;
  }
  return total + countSegment(rule, text.slice(cursor));
}
