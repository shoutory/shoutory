import { describe, expect, it } from "vitest";
import { mediaFits, type RejectReason } from "./media.js";

// The one rule set for what a provider takes, read from its manifest: the same function at attach, at ready and at
// prepare, so a medium cannot pass one gate and fail another.
const SOURCE = { source: "https://docs.example.test/limits", checked: "2026-11-21" };
const rules = (capabilities: string[], limits: Record<string, number> = {}) => ({
  capabilities,
  limits: Object.fromEntries(Object.entries(limits).map(([name, value]) => [name, { value, ...SOURCE }])),
});
const image = { mime: "image/png", bytes: 1000, width: 400, height: 300 };
const fits = { ok: true };
const refused = (reason: RejectReason) => ({ ok: false, reason });

describe("mediaFits", () => {
  // [what is wrong, the medium, the manifest, the answer]
  it.each([
    ["nothing wrong and no limit named", image, rules(["image"]), fits],
    ["a size at the limit", image, rules(["image"], { imageMaxBytes: 1000 }), fits],
    ["a size over the limit", image, rules(["image"], { imageMaxBytes: 999 }), refused("too_large")],
    ["pixels at the limit", image, rules(["image"], { imageMaxPixels: 120_000 }), fits],
    ["pixels over the limit", image, rules(["image"], { imageMaxPixels: 119_999 }), refused("pixel_limit")],
    ["the last of the allowed count", { ...image, count: 1 }, rules(["image"], { mediaMaxCount: 1 }), fits],
    [
      "one over the count",
      { ...image, count: 2 },
      rules(["image"], { mediaMaxCount: 1 }),
      refused("too_many"),
    ],
    ["a manifest without the image capability", image, rules(["text"]), refused("unsupported_type")],
    [
      "a type outside the supported list",
      { ...image, mime: "image/tiff" },
      rules(["image"]),
      refused("unsupported_type"),
    ],
    ["a limit that is not named is no limit", image, rules(["image"], { textLength: 1 }), fits],
  ])("%s", (_name, medium, manifest, expected) => {
    expect(mediaFits(medium, manifest)).toEqual(expected);
  });
});
