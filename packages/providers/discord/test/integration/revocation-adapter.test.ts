import { SealedSecret } from "@shoutory/core/crypto";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { describe, expect, it } from "vitest";
import { createDiscordAdapter } from "../../src/adapter.js";
import { accountOf, json, MESSAGE_ID, scripted } from "../support/webhook.js";

const adapter = createDiscordAdapter();
const UNKNOWN_WEBHOOK = () => json(404, { code: 10015, message: "Unknown Webhook" });
const INVALID_TOKEN = () => json(401, { code: 50027, message: "Invalid Webhook Token" });
const post = { externalId: MESSAGE_ID, account: accountOf() };
const inspectChannel = (context: Parameters<typeof adapter.inspect>[0]) =>
  adapter.inspect(context, { accessToken: new SealedSecret(accountOf().accessToken.expose()) });

// Discord bans an address after 10,000 invalid requests in 10 minutes (401, 403 and 429 count) and asks that a 404 webhook
// is never used again, so a deleted webhook must cost the install two requests at most: the call that found it, and the
// one re-read that confirms it before the channel moves.
describe("a deleted webhook stops the channel before the invalid-request ban threshold (floor)", () => {
  it.each([
    ["a 404 for an unknown webhook", UNKNOWN_WEBHOOK],
    ["a 401 for an invalid token", INVALID_TOKEN],
  ])("%s on a send is revoked, and the one confirming read says so too", async (_name, answer) => {
    const { context } = scripted([answer(), answer()]);
    const sent = await adapter.commit(context, {
      idempotencyKey: "revoke-1",
      text: "t",
      account: accountOf(),
    });
    expect(sent).toMatchObject({ ok: false, effect: "none", errorClass: "auth_revoked" });
    const confirmed = await inspectChannel(context);
    expect(confirmed).toMatchObject({ ok: false, errorClass: "auth_revoked" });
  });

  // The codes name the webhook, whatever status carries them.
  it.each([
    [400, 10015],
    [403, 10015],
    [400, 50027],
    [403, 50027],
    [404, 50027],
  ])("a %d with code %d is a gone webhook, not a refusal of one operation", async (status, code) => {
    const { context } = scripted([json(status, { code, message: "x" })]);
    const answer = await adapter.commit(context, {
      idempotencyKey: "code-1",
      text: "t",
      account: accountOf(),
    });
    expect(answer).toMatchObject({ ok: false, effect: "none", errorClass: "auth_revoked" });
  });

  type Run = (context: Parameters<typeof adapter.inspect>[0]) => Promise<ProviderResult> | undefined;
  const UNKNOWN_MESSAGE = { code: 10008, message: "Unknown Message" };
  it.each<[string, Run, object]>([
    ["a read", (context) => adapter.readBack(context, post), { ok: false, absent: true }],
    ["a source read", (context) => adapter.readSource?.(context, post), { ok: false, absent: true }],
    ["an edit", (context) => adapter.edit?.(context, post, { text: "t" }), { ok: false, absent: true }],
    ["a delete (already gone)", (context) => adapter.delete(context, post), { ok: true, effect: "none" }],
  ])("an unknown message on %s is absence and never revokes the channel", async (_name, run, expected) => {
    const { context } = scripted([json(404, UNKNOWN_MESSAGE)]);
    const answer = await run(context);
    expect(answer).toMatchObject(expected);
    expect(answer?.errorClass).not.toBe("auth_revoked");
  });

  it("a 403 is refused for that operation and never revokes the channel", async () => {
    const { context } = scripted([json(403, { code: 50013, message: "Missing Permissions" })]);
    const answer = await adapter.commit(context, {
      idempotencyKey: "forbidden-1",
      text: "t",
      account: accountOf(),
    });
    expect(answer).toMatchObject({ ok: false, effect: "none", errorClass: "permanent", httpStatus: 403 });
    expect(answer.providerCode).toBe("50013");
  });
});
