import { describe, expect, it } from "vitest";
import type { Draft } from "./document.js";
import { buildSnapshot, type Resolved, snapshotHash } from "./snapshot.js";

const CH = "00000000-0000-4000-8000-0000000000a1";
const MEDIA = "00000000-0000-4000-8000-0000000000b1";
const SHA = "ab".repeat(32);
const variant = (change: object = {}) => ({
  channel_id: CH,
  locale: null,
  post_type: "text",
  text: "héllo ✓",
  parts: [],
  settings: {},
  media: [],
  ...change,
});
const draft = (...variants: object[]) => ({ variants }) as Draft;
const resolved = (settings: Record<string, unknown> = {}): Resolved => ({
  variants: [{ channel_id: CH, locale: null, settings }],
  media: {},
  manifestDigest: { [CH]: "digest-1" },
});
const refuses = (run: () => unknown) => {
  expect(run).toThrow();
  expect(run).not.toThrow("not implemented");
};
const snap = (value: Draft, extra: Resolved = resolved()) => {
  const built = buildSnapshot(value, extra);
  if (!built.ok) throw new Error(built.code);
  return built.snapshot;
};
const hashOf = (value: Draft, extra: Resolved = resolved()) =>
  snapshotHash(snap(value, extra)).toString("hex");
// Postgres renders jsonb as text with `": "` and `", "` separators; the limit is on those bytes.
const pgText = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(pgText).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value).map(([key, member]) => `${JSON.stringify(key)}: ${pgText(member)}`);
    return `{${members.join(", ")}}`;
  }
  return JSON.stringify(value);
};
const SLOTS = 11;
const ofBytes = (bytes: number): [Draft, Resolved] => {
  const build = (pads: string[]): [Draft, Resolved] => [
    draft(...pads.map((pad, i) => variant({ locale: `l${i}`, text: pad }))),
    { ...resolved(), variants: pads.map((_, i) => ({ channel_id: CH, locale: `l${i}`, settings: {} })) },
  ];
  const [empty, block] = build(Array(SLOTS).fill(""));
  const base = Buffer.byteLength(pgText({ version: 1, draft: empty, resolved: block }));
  const each = Math.floor((bytes - base) / SLOTS);
  const extra = (bytes - base) % SLOTS;
  return build(Array.from({ length: SLOTS }, (_, i) => "a".repeat(each + (i < extra ? 1 : 0))));
};

describe("snapshotHash", () => {
  it("is 32 bytes and equals the SHA-256 of the canonical JSON, pinned as a golden value", () => {
    const hash = snapshotHash(snap(draft(variant())));
    expect(hash).toHaveLength(32);
    expect(hash.toString("hex")).toBe("f97ce3106534cc3ac30cf0633a072b469d4a027a4deb759918ec9b5e863c52c6");
  });

  it("is the same whatever order the keys were written in", () => {
    const reordered = {
      text: "héllo ✓",
      media: [],
      settings: {},
      parts: [],
      post_type: "text",
      locale: null,
      channel_id: CH,
    };
    expect(hashOf(draft(reordered))).toBe(hashOf(draft(variant())));
  });

  const CHANGES: [string, Draft, Resolved][] = [
    ["a text", draft(variant({ text: "héllo ✗" })), resolved()],
    ["a media id", draft(variant({ media: [{ media_id: MEDIA, alt_text: null, crop: null }] })), resolved()],
    ["an alt text", draft(variant({ media: [{ media_id: MEDIA, alt_text: "a", crop: null }] })), resolved()],
    ["a setting", draft(variant({ settings: { n: 1 } })), resolved({ n: 1 })],
    ["a resolved setting", draft(variant()), resolved({ n: 2 })],
    [
      "a locale",
      draft(variant({ locale: "ar" })),
      { ...resolved(), variants: [{ channel_id: CH, locale: "ar", settings: {} }] },
    ],
  ];
  it.each(CHANGES)("changes with %s", (_what, value, extra) => {
    expect(hashOf(value, extra)).not.toBe(hashOf(draft(variant())));
  });

  const REFUSED: [string, unknown][] = [
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a float", 1.5],
    ["a Date", new Date(0)],
    ["a bigint", 10n],
    ["a sparse array", new Array(3)],
  ];
  it.each(REFUSED)("refuses %s in a setting", (_what, value) => {
    const settings = { k: value };
    refuses(() =>
      snapshotHash({ version: 1, draft: draft(variant({ settings })), resolved: resolved(settings) }),
    );
  });
});

describe("buildSnapshot", () => {
  it("wraps the draft with version 1 and the resolved block", () => {
    expect(buildSnapshot(draft(variant()), resolved())).toEqual({
      ok: true,
      snapshot: { version: 1, draft: draft(variant()), resolved: resolved() },
    });
  });

  it("matches a resolved locale to the draft by key only, with no length bound of its own", () => {
    const long = "x".repeat(40);
    const block = { ...resolved(), variants: [{ channel_id: CH, locale: long, settings: {} }] };
    expect(buildSnapshot(draft(variant({ locale: long })), block)).toMatchObject({ ok: true });
  });

  const MISMATCHES: [string, Resolved][] = [
    [
      "a variant the draft does not have",
      {
        ...resolved(),
        variants: [...resolved().variants, { channel_id: MEDIA, locale: null, settings: {} }],
      },
    ],
    ["a missing variant", { ...resolved(), variants: [] }],
    ["a variant listed twice", { ...resolved(), variants: [...resolved().variants, ...resolved().variants] }],
    ["another locale", { ...resolved(), variants: [{ channel_id: CH, locale: "ar", settings: {} }] }],
    ["a media digest that is not 64 hex characters", { ...resolved(), media: { [MEDIA]: "xyz" } }],
  ];
  it.each(MISMATCHES)("refuses a resolved block with %s", (_what, block) => {
    refuses(() => buildSnapshot(draft(variant()), block));
  });

  it("accepts a media digest of 64 hex characters", () => {
    expect(buildSnapshot(draft(variant()), { ...resolved(), media: { [MEDIA]: SHA } })).toMatchObject({
      ok: true,
    });
  });

  it("takes a snapshot of exactly 1 MiB as jsonb text and answers snapshot_too_large one byte over", () => {
    expect(buildSnapshot(...ofBytes(1048576))).toMatchObject({ ok: true });
    expect(buildSnapshot(...ofBytes(1048577))).toEqual({ ok: false, code: "snapshot_too_large" });
  });
});
