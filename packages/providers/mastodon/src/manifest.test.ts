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

  it("declares the settings a post may carry, with the account's own visibility as the default", () => {
    expect(parsed.providerDefault).toEqual({ visibility: "default", sensitive: false, spoiler_text: "" });
  });

  it("spends the media token per upload and the delete token on delete turns only", () => {
    expect(Object.fromEntries(parsed.rateLimits.map((limit) => [limit.name, limit.spentBy]))).toEqual({
      api: "turn",
      media: "upload",
      delete: "delete",
    });
  });

  it("states the upload timeout and the processing wait the worker bounds a call and a wait with", () => {
    expect([parsed.uploadTimeoutSeconds, parsed.maxProcessingSeconds]).toEqual([300, 600]);
    expect(parsed.leaseSeconds).toEqual({ prepare: 60, commit: 120, readBack: 60, edit: 60, delete: 60 });
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
