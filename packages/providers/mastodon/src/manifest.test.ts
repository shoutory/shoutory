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

  it.each(Object.entries(parsed.limits))(
    "the limit %s carries an https source and an ISO date",
    (_name, limit) => {
      expect(limit.source).toMatch(/^https:\/\//);
      expect(limit.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
  );
});
