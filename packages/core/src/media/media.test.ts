import { describe, expect, it } from "vitest";
import { mediaFits, type RejectReason } from "./media.js";

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

describe("mediaFits for a video", () => {
  const video = { mime: "video/mp4", bytes: 1000, width: 400, height: 300, durationMs: 10_000 };
  // [what is wrong, the video, the manifest, the answer]
  it.each([
    ["a video with the capability and no limit named", video, rules(["video"]), fits],
    ["a video size at the limit", video, rules(["video"], { videoMaxBytes: 1000 }), fits],
    ["a video size over the limit", video, rules(["video"], { videoMaxBytes: 999 }), refused("too_large")],
    ["a length at the limit", video, rules(["video"], { videoMaxDurationMs: 10_000 }), fits],
    ["a length over the limit", video, rules(["video"], { videoMaxDurationMs: 9999 }), refused("too_long")],
    [
      "a video of unknown length under a length limit",
      { ...video, durationMs: null },
      rules(["video"], { videoMaxDurationMs: 10_000 }),
      refused("too_long"),
    ],
    ["pixels at the limit", video, rules(["video"], { videoMaxPixels: 120_000 }), fits],
    ["pixels over the limit", video, rules(["video"], { videoMaxPixels: 119_999 }), refused("pixel_limit")],
    ["a manifest without the video capability", video, rules(["image"]), refused("unsupported_type")],
    [
      "a video type outside the supported list",
      { ...video, mime: "video/x-matroska" },
      rules(["video"]),
      refused("unsupported_type"),
    ],
    ["an image on a manifest that has only video", image, rules(["video"]), refused("unsupported_type")],
    ["an image limit is no limit for a video", video, rules(["image", "video"], { imageMaxBytes: 1 }), fits],
    [
      "a video limit is no limit for an image",
      image,
      rules(["image", "video"], { videoMaxBytes: 1, videoMaxDurationMs: 1 }),
      fits,
    ],
  ])("%s", (_name, medium, manifest, expected) => {
    expect(mediaFits(medium, manifest)).toEqual(expected);
  });
});
