import { countText } from "@shoutory/core/counting";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { describe, expect, it } from "vitest";
import { mastodonManifest } from "./manifest.js";

describe("the manifest of the instance provider", () => {
  const parsed = manifestSchema.parse(mastodonManifest);

  // A delete whose outcome is unknown may have removed the post or not, and the page documents no key for it: no
  // automatic resend follows an unknown outcome, a person decides.
  it("forbids an automatic resend of a delete after an unknown outcome", () => {
    expect(parsed.retrySafety.delete).toBe("never");
  });

  it.each([
    ["a family emoji is one character", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}", 1],
    [
      "a link counts the reserved 23 whatever its length",
      "https://example.com/a/very/long/path/indeed/yes",
      23,
    ],
    ["a remote mention counts its local part", "@user@example.social hi", 8],
  ])("counts as the instance does: %s", (_title, text, expected) => {
    expect(countText(parsed.counting, text)).toBe(expected);
  });

  it.each(Object.entries(parsed.limits))(
    "the limit %s carries an https source and an ISO date",
    (_name, limit) => {
      expect(limit.source).toMatch(/^https:\/\//);
      expect(limit.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
  );
});
