import { describe, expect, it } from "vitest";
import { type Draft, draftSchema, settingsIssues, supportsVariant } from "./document.js";

const CH = "00000000-0000-4000-8000-0000000000a1";
const MEDIA = "00000000-0000-4000-8000-0000000000b1";
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
];
const variant = (change: object = {}) => ({
  channel_id: CH,
  locale: null,
  post_type: "text",
  text: "x",
  parts: [],
  settings: {},
  media: [],
  ...change,
});
const draft = (...variants: object[]) => ({ variants });
const asDraft = (...variants: object[]): Draft => draft(...variants) as Draft;
const part = (text = "x") => ({ kind: "thread_reply", text });
const medium = (change: object = {}) => ({ media_id: MEDIA, alt_text: null, crop: null, ...change });
const locales = (n: number) =>
  Array.from({ length: n }, (_, i) => variant({ locale: `en-x-l${String(i).padStart(2, "0")}` }));
// Postgres renders jsonb as text with `": "` and `", "` separators, and the limits are on those bytes.
const pgText = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(pgText).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value).map(([key, member]) => `${JSON.stringify(key)}: ${pgText(member)}`);
    return `{${members.join(", ")}}`;
  }
  return JSON.stringify(value);
};
const nested = (depth: number): unknown => {
  let value: unknown = 1;
  for (let level = 0; level < depth; level += 1) value = { a: value };
  return value;
};
const deepArray = (depth: number): unknown => {
  let value: unknown = 1;
  for (let level = 0; level < depth; level += 1) value = [value];
  return value;
};
const sized = (bytes: number, make: (pads: string[]) => unknown, slots = 1) => {
  const base = Buffer.byteLength(pgText(make(Array(slots).fill(""))));
  const each = Math.floor((bytes - base) / slots);
  const pads = Array.from({ length: slots }, (_, i) =>
    "a".repeat(each + (i === 0 ? (bytes - base) % slots : 0)),
  );
  return make(pads);
};
const sizedParts = (bytes: number) => sized(bytes, (pads) => pads.map((pad) => part(pad)), 3);

const BOUNDS: [string, unknown, boolean][] = [
  ["text of 100000 code points, all astral", draft(variant({ text: "😀".repeat(100000) })), true],
  ["text of 100001 code points", draft(variant({ text: "😀".repeat(100001) })), false],
  ["100 variants", draft(...locales(100)), true],
  ["101 variants", draft(...locales(101)), false],
  ["61 parts, bounded by bytes alone", draft(variant({ parts: Array(61).fill(part()) })), true],
  ["a part of an unknown kind", draft(variant({ parts: [{ kind: "reply_all", text: "x" }] })), false],
  ["parts of 262144 bytes", draft(variant({ parts: sizedParts(262144) })), true],
  ["parts of 262145 bytes", draft(variant({ parts: sizedParts(262145) })), false],
  ["settings of 65536 bytes", draft(variant({ settings: sized(65536, ([pad]) => ({ k: pad })) })), true],
  ["settings of 65537 bytes", draft(variant({ settings: sized(65537, ([pad]) => ({ k: pad })) })), false],
  [
    "settings with nested safe integers, strings, booleans and null",
    draft(variant({ settings: { a: { b: [1, "x", true, null] } } })),
    true,
  ],
  [
    "settings of 65536 bytes with 3-byte characters",
    draft(variant({ settings: { k: `${"€".repeat(21842)}a` } })),
    true,
  ],
  [
    "settings of 65537 bytes with 3-byte characters",
    draft(variant({ settings: { k: `${"€".repeat(21842)}aa` } })),
    false,
  ],
  ["settings nested 32 levels", draft(variant({ settings: nested(32) })), true],
  ["settings nested 33 levels", draft(variant({ settings: nested(33) })), false],
  // 20000 array levels are 40000 bytes, under the size limit, so only a depth cap stops the walk.
  ["settings nested 20000 array levels", draft(variant({ settings: { a: deepArray(20000) } })), false],
  ["a bigint in settings", draft(variant({ settings: { k: 10n } })), false],
  ["a function in settings", draft(variant({ settings: { k: () => 1 } })), false],
  ["a __proto__ key in settings", draft(variant({ settings: JSON.parse('{"__proto__": 1}') })), false],
  [
    "a __proto__ key in a crop",
    draft(variant({ media: [medium({ crop: JSON.parse('{"__proto__": 1}') })] })),
    false,
  ],
  ["a float in settings", draft(variant({ settings: { n: 1.5 } })), false],
  ["an unsafe integer in settings", draft(variant({ settings: { n: 2 ** 53 } })), false],
  ["a float nested in settings", draft(variant({ settings: { a: { b: [1.5] } } })), false],
  ["32 media", draft(variant({ media: Array(32).fill(medium()) })), true],
  ["33 media", draft(variant({ media: Array(33).fill(medium()) })), false],
  [
    "alt text of 2000 code points",
    draft(variant({ media: [medium({ alt_text: "😀".repeat(2000) })] })),
    true,
  ],
  [
    "alt text of 2001 code points",
    draft(variant({ media: [medium({ alt_text: "😀".repeat(2001) })] })),
    false,
  ],
  [
    "a crop of 1024 bytes",
    draft(variant({ media: [medium({ crop: sized(1024, ([pad]) => ({ k: pad })) })] })),
    true,
  ],
  [
    "a crop of 1025 bytes",
    draft(variant({ media: [medium({ crop: sized(1025, ([pad]) => ({ k: pad })) })] })),
    false,
  ],
  ["a crop that is not an object", draft(variant({ media: [medium({ crop: "x" })] })), false],
  ["a locale of 1 character", draft(variant({ locale: "a" })), false],
  ["a locale of 2 characters", draft(variant({ locale: "ar" })), true],
  ["a locale of 35 characters", draft(variant({ locale: "en-x-aaaaaaaa-bbbbbbbb-cccccccc-ddd" })), true],
  ["a locale of 36 characters", draft(variant({ locale: "en-x-aaaaaaaa-bbbbbbbb-cccccccc-dddd" })), false],
  ["an empty locale", draft(variant({ locale: "" })), false],
  ["a locale that is not a language tag", draft(variant({ locale: "xx!!" })), false],
  [
    "two variants of one channel whose locales differ only in case",
    draft(variant({ locale: "en-us" }), variant({ locale: "en-US" })),
    false,
  ],
  ["a post type outside the list", draft(variant({ post_type: "bogus" })), false],
  ["a media id that is not a uuid", draft(variant({ media: [medium({ media_id: "m1" })] })), false],
  ["a channel id that is not a uuid", draft(variant({ channel_id: "c1" })), false],
  ["an unknown key on the draft", { variants: [variant()], extra: 1 }, false],
  ["an unknown key on a variant", draft(variant({ extra: 1 })), false],
  ["an unknown key on a medium", draft(variant({ media: [medium({ extra: 1 })] })), false],
  ["an unknown key on a part", draft(variant({ parts: [{ ...part(), extra: 1 }] })), false],
  ["two variants of one channel, both without a locale", draft(variant(), variant()), false],
  [
    "two variants of one channel and locale",
    draft(variant({ locale: "ar" }), variant({ locale: "ar" })),
    false,
  ],
  [
    "two variants of one channel written in upper and lower case",
    draft(variant(), variant({ channel_id: CH.toUpperCase() })),
    false,
  ],
  ["one channel without a locale and with one", draft(variant(), variant({ locale: "ar" })), true],
  [
    "two channels with one locale",
    draft(variant({ locale: "ar" }), variant({ channel_id: MEDIA, locale: "ar" })),
    true,
  ],
  ...POST_TYPES.map((type): [string, unknown, boolean] => [
    `post type ${type}`,
    draft(variant({ post_type: type })),
    true,
  ]),
];

describe("draft bounds", () => {
  it.each(BOUNDS)("%s", (_what, value, accepted) => {
    expect(draftSchema.safeParse(value).success).toBe(accepted);
  });
});

// jsonb refuses U+0000 (22P05) and a string that is not well formed UTF-16 (22P02): core must refuse them first.
const NUL = "a\u0000b";
const LONE = "a\ud800b";
const UNSTORABLE: [string, unknown][] = [
  ["a NUL in the text", draft(variant({ text: NUL }))],
  ["a lone surrogate in the text", draft(variant({ text: LONE }))],
  ["a NUL in the locale", draft(variant({ locale: NUL }))],
  ["a lone surrogate in alt text", draft(variant({ media: [medium({ alt_text: LONE })] }))],
  ["a NUL in part text", draft(variant({ parts: [part(NUL)] }))],
  ["a lone surrogate in part text", draft(variant({ parts: [part(LONE)] }))],
  ["a NUL in a settings value", draft(variant({ settings: { k: NUL } }))],
  ["a lone surrogate in a nested settings value", draft(variant({ settings: { a: [LONE] } }))],
  ["a NUL in a settings key", draft(variant({ settings: { [NUL]: 1 } }))],
  ["a lone surrogate in a crop key", draft(variant({ media: [medium({ crop: { [LONE]: 1 } })] }))],
];

describe("strings the database cannot store", () => {
  it.each(UNSTORABLE)("refuses %s", (_what, value) => {
    expect(draftSchema.safeParse(value).success).toBe(false);
  });
});

describe("a language tag is stored in its canonical case", () => {
  it.each([
    ["en-us", "en-US"],
    ["zh-hant-tw", "zh-Hant-TW"],
    ["AR", "ar"],
  ])("%s becomes %s", (given, canonical) => {
    expect(draftSchema.parse(draft(variant({ locale: given }))).variants[0]?.locale).toBe(canonical);
  });
});

describe("supportsVariant", () => {
  const RULES = { capabilities: ["text", "image"], followUpRoles: ["first_comment"] };
  const comment = { kind: "first_comment", text: "x" };
  const ROWS: [string, object, boolean][] = [
    ["text on a channel that takes text", {}, true],
    ["multi_image on a channel that takes images", { post_type: "multi_image" }, true],
    ["video on a channel without video", { post_type: "video" }, false],
    ...["document", "article", "reel", "story", "event", "offer"].map((type): [string, object, boolean] => [
      `${type}, which no capability covers`,
      { post_type: type },
      false,
    ]),
    ["a first comment the channel takes", { parts: [comment] }, true],
    ["a thread reply the channel does not take", { parts: [comment, part()] }, false],
  ];
  it.each(ROWS)("%s", (_what, change, supported) => {
    const [checked] = asDraft(variant(change)).variants;
    expect(checked && supportsVariant(checked, RULES)).toBe(supported);
  });
});

describe("settingsIssues", () => {
  const DEFAULTS = { [CH]: { max_length: 280, sensitive: false, tag: "x" } };
  const ROWS: [string, object, object[]][] = [
    ["declared keys of the same type", { max_length: 100, sensitive: true, tag: "y" }, []],
    ["a key the channel does not declare", { nope: 1 }, [{ variant: 0, key: "nope", reason: "undeclared" }]],
    [
      "a declared key of another type",
      { max_length: "100" },
      [{ variant: 0, key: "max_length", reason: "type" }],
    ],
    [
      "an object where a primitive is declared",
      { tag: { a: 1 } },
      [{ variant: 0, key: "tag", reason: "type" }],
    ],
  ];
  it.each(ROWS)("%s", (_what, settings, issues) => {
    expect(settingsIssues(asDraft(variant({ settings })), DEFAULTS)).toEqual(issues);
  });

  it("a channel with no declared defaults declares nothing", () => {
    expect(settingsIssues(asDraft(variant({ settings: { tag: "x" } })), {})).toEqual([
      { variant: 0, key: "tag", reason: "undeclared" },
    ]);
  });

  it("an upper-case channel id finds the defaults kept under its lower-case form", () => {
    const upper = variant({ channel_id: CH.toUpperCase(), settings: { max_length: 100, nope: 1 } });
    expect(settingsIssues(asDraft(upper), DEFAULTS)).toEqual([
      { variant: 0, key: "nope", reason: "undeclared" },
    ]);
  });
});
