import { z } from "zod";

// Checked in full before it reaches the database: Postgres would drop an unknown key, and `jsonb` takes a float. Text
// bounds count code points like `char_length`; byte bounds count the UTF-8 bytes of the text Postgres renders for the
// `jsonb` value, so core and the database agree at the limit.

const POST_TYPES = [
  "text",
  "image",
  "multi_image",
  "video",
  "document",
  "article",
  "reel",
  "story",
  "event",
  "offer",
] as const;

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

// jsonb refuses U+0000 and a string that is not well formed UTF-16, so every string of a document must be clean.
const isClean = (text: string) => text.isWellFormed() && !text.includes("\u0000");
const cleanText = z.string().refine(isClean, { message: "well-formed text with no U+0000" });

const chars = (min: number, max: number) =>
  z.string().refine((text) => isClean(text) && codePoints(text) >= min && codePoints(text) <= max, {
    message: `${min} to ${max} characters of well-formed text with no U+0000`,
  });

const encoder = new TextEncoder();
const textBytes = (text: string) => encoder.encode(text).length;
// Postgres writes `, ` between members and `: ` after a key; the escapes inside strings are those of JSON.stringify.
const SEPARATOR = 2;

function scalarBytes(value: unknown): number | undefined {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "string") return textBytes(JSON.stringify(value));
  return typeof value === "number" && Number.isFinite(value) ? String(value).length : undefined;
}

function membersOf(node: object): [string | null, unknown][] | undefined {
  if (Array.isArray(node)) return Array.from(node, (item): [null, unknown] => [null, item]);
  const prototype = Object.getPrototypeOf(node);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const entries = Object.entries(node);
  return entries.some(([key]) => key === "__proto__") ? undefined : entries;
}

// Counted without building the text and without recursion, so a very deep value cannot overflow the stack.
export function jsonbBytes(value: unknown, maxDepth = 32): number | undefined {
  let total = 0;
  const pending: [unknown, number][] = [[value, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, depth] = next;
    if (typeof node !== "object" || node === null) {
      const size = scalarBytes(node);
      if (size === undefined) return undefined;
      total += size;
      continue;
    }
    const members = membersOf(node);
    if (members === undefined || depth + 1 > maxDepth) return undefined;
    total += 2 + SEPARATOR * Math.max(members.length - 1, 0);
    for (const [key, member] of members) {
      if (key !== null) total += textBytes(JSON.stringify(key)) + SEPARATOR;
      pending.push([member, depth + 1]);
    }
  }
  return total;
}

// The raw size is checked first, so a huge value is refused before the schema walks it.
const withinBytes = <T extends z.ZodType>(schema: T, max: number) =>
  z
    .unknown()
    .refine(
      (value) => {
        const size = jsonbBytes(value);
        return size !== undefined && size <= max;
      },
      { message: `plain JSON of at most ${max} bytes, nested at most 32 levels` },
    )
    .pipe(schema);

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    cleanText,
    z.number().refine(Number.isSafeInteger, { message: "an integer within the safe range" }),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(cleanText, json),
  ]),
);
const jsonObject = z.record(cleanText, json);

// Stored in the case RFC 5646 section 2.1.1 gives, so one channel cannot hold "en-us" and "en-US" as two targets.
const languageTag = cleanText
  .transform((tag, ctx) => {
    try {
      return Intl.getCanonicalLocales(tag)[0] ?? tag;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      ctx.addIssue({ code: "custom", message: "a BCP 47 language tag" });
      return z.NEVER;
    }
  })
  .pipe(chars(2, 35));

const partSchema = z.strictObject({ kind: z.enum(["thread_reply", "first_comment"]), text: cleanText });
const mediumSchema = z.strictObject({
  media_id: z.guid(),
  alt_text: chars(0, 2000).nullable(),
  crop: withinBytes(jsonObject, 1024).nullable(),
});
const variantSchema = z.strictObject({
  channel_id: z.guid(),
  locale: languageTag.nullable(),
  post_type: z.enum(POST_TYPES),
  text: chars(0, 100000),
  parts: withinBytes(z.array(partSchema), 262144),
  settings: withinBytes(jsonObject, 65536),
  media: z.array(mediumSchema).max(32),
});

// One variant per channel and locale; a missing locale counts as one value, and a uuid compares in lower case.
export const targetOf = (variant: { channel_id: string; locale: string | null }) =>
  `${variant.channel_id.toLowerCase()} ${variant.locale ?? ""}`;

export const draftSchema = z
  .strictObject({ variants: z.array(variantSchema).max(100) })
  .refine((draft) => new Set(draft.variants.map(targetOf)).size === draft.variants.length, {
    message: "two variants of one channel and locale",
    path: ["variants"],
  });

export type Draft = z.infer<typeof draftSchema>;
export type Variant = Draft["variants"][number];

// The capability a post type needs; a type no capability covers yet is taken by no channel.
const TYPE_CAPABILITY: Record<(typeof POST_TYPES)[number], string | null> = {
  text: "text",
  image: "image",
  multi_image: "image",
  video: "video",
  document: null,
  article: null,
  reel: null,
  story: null,
  event: null,
  offer: null,
};

export function supportsVariant(
  variant: Variant,
  rules: { capabilities: readonly string[]; followUpRoles: readonly string[] },
): boolean {
  const needed = TYPE_CAPABILITY[variant.post_type];
  if (needed === null || !rules.capabilities.includes(needed)) return false;
  return variant.parts.every((part) => rules.followUpRoles.includes(part.kind));
}

export interface SettingsIssue {
  variant: number;
  key: string;
  reason: "undeclared" | "type";
}

// The channel's `providerDefault` map arrives as a plain record keyed by the lower-case channel id, so core imports
// nothing from the provider package.
export function settingsIssues(
  draft: Draft,
  providerDefaults: Readonly<Record<string, Readonly<Record<string, string | number | boolean>>>>,
): SettingsIssue[] {
  return draft.variants.flatMap((variant, index) => {
    const declared = providerDefaults[variant.channel_id.toLowerCase()] ?? {};
    return Object.entries(variant.settings).flatMap(([key, value]): SettingsIssue[] => {
      if (!Object.hasOwn(declared, key)) return [{ variant: index, key, reason: "undeclared" }];
      return typeof value === typeof declared[key] ? [] : [{ variant: index, key, reason: "type" }];
    });
  });
}
