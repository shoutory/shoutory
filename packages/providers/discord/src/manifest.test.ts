import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { describe, expect, it } from "vitest";
import { discordManifest } from "./manifest.js";

describe("the Discord manifest declares what the docs state, each with its page and date", () => {
  it.each([
    ["textLength", 2000],
    ["imageMaxBytes", 20 * 1024 ** 2],
    ["requestMaxBytes", 25 * 1024 ** 2],
    ["embedMaxCount", 10],
    ["embedTextMax", 6000],
  ])("%s is %d", (name, value) => {
    const limit = discordManifest.limits[name];
    expect(limit?.value).toBe(value);
    expect(limit?.source).toMatch(/^https:\/\/docs\.discord\.com\/developers\//);
    expect(limit?.checked).toBe("2026-11-27");
  });

  it("states no file count, which no page read gives", () => {
    expect(discordManifest.limits.mediaMaxCount).toBeUndefined();
  });

  // The docs say "characters" and never how they are counted; UTF-16 units are the strictest of the rules that count
  // each character at least once for the text a person writes.
  it("counts text in UTF-16 units", () => {
    expect(discordManifest.counting).toEqual({ unit: "utf16" });
  });

  // A 25 MiB request must be able to finish: the call is bounded by callTimeoutSeconds and by its lease.
  it("gives a commit time for a 25 MiB request inside its lease", () => {
    expect(discordManifest.callTimeoutSeconds).toBeGreaterThanOrEqual(120);
    expect(discordManifest.leaseSeconds.commit).toBeGreaterThan(discordManifest.callTimeoutSeconds);
  });

  it("is a webhook provider with no read-back, no resend after an unknown send and no absent status", () => {
    expect(manifestSchema.parse(discordManifest)).toMatchObject({
      auth: { method: "webhook_url" },
      readBackMode: "E",
      retrySafety: { commit: "never" },
      idempotency: { mechanism: "none" },
      absentAnswers: [],
      egressHosts: ["discord.com", "discordapp.com"],
    });
  });
});
