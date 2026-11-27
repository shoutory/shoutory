import { SealedSecret } from "@shoutory/core/crypto";
import { describe, expect, it } from "vitest";
import { createDiscordAdapter } from "../../src/adapter.js";
import { json, scripted, WEBHOOK_ID, WEBHOOK_TOKEN, WEBHOOK_URL } from "../support/webhook.js";

const verify = (secret: string, replies: Parameters<typeof scripted>[0] = []) => {
  const { context, seen } = scripted(replies);
  const check = createDiscordAdapter().connect?.verifySecret;
  if (!check) throw new Error("the adapter has no verifySecret");
  return { seen, answer: check(context, { kind: "webhook_url", secret: new SealedSecret(secret) }) };
};

const PATH = `/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;

describe("a webhook URL the manifest does not allow is refused before any request (floor)", () => {
  it.each([
    ["another host", `https://example.com${PATH}`],
    ["a lookalike host", `https://discord.com.example.net${PATH}`],
    ["a subdomain", `https://canary.discord.com${PATH}`],
    ["userinfo", `https://user:pass@discord.com${PATH}`],
    ["userinfo naming another host", `https://discord.com@example.com${PATH}`],
    ["a port", `https://discord.com:8443${PATH}`],
    ["plain http", `http://discord.com${PATH}`],
    ["another scheme", `ftp://discord.com${PATH}`],
    ["a query", `https://discord.com${PATH}?thread_id=1`],
    ["a fragment", `https://discord.com${PATH}#x`],
    ["a path that is not a webhook", "https://discord.com/api/users/@me"],
    ["a provider-specific suffix", `https://discord.com${PATH}/slack`],
    ["an id that is not a snowflake", `https://discord.com/api/webhooks/not-an-id/${WEBHOOK_TOKEN}`],
    ["a token with a slash", `https://discord.com/api/webhooks/${WEBHOOK_ID}/a%2Fb`],
    ["text that is no URL", "not a url"],
    ["an empty value", ""],
  ])("%s", async (_name, secret) => {
    const { answer, seen } = verify(secret);
    expect(await answer).toMatchObject({ ok: false, effect: "none", errorClass: "permanent" });
    expect(seen).toEqual([]);
  });

  it.each([
    ["discord.com", WEBHOOK_URL],
    ["discordapp.com", `https://discordapp.com${PATH}`],
  ])("%s is accepted and the account is the webhook", async (host, secret) => {
    const named = { id: WEBHOOK_ID, type: 1, name: "Announcements", channel_id: "323456789012345678" };
    const { answer, seen } = verify(secret, [json(200, named)]);
    expect(await answer).toMatchObject({
      ok: true,
      identity: { providerAccountId: WEBHOOK_ID, displayName: "Announcements" },
    });
    expect(seen.map((request) => new URL(request.url).host)).toEqual([host]);
    expect(seen[0]?.userAgent).toMatch(/^DiscordBot \(/);
  });
});
