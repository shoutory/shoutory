import { SealedSecret } from "@shoutory/core/crypto";
import type { AdapterContext } from "@shoutory/provider-sdk/adapter";
import {
  type FaultRow,
  faultMatrixRows,
  type MatrixHarness,
} from "@shoutory/provider-sdk/conformance/fault-matrix";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramAdapter } from "../../src/adapter.js";
import { telegramManifest } from "../../src/manifest.js";
import { startTelegramSimulator, type TelegramSimulator } from "../../src/simulator.js";

// The documented refusals the matrix plays on a send: a chat the bot cannot find, text Telegram refuses as too long, and
// a token Telegram answers 401 for (core.telegram.org/bots/api, read 2026-11-27).
const rows = faultMatrixRows({
  manifest: telegramManifest,
  badRequestCodes: ["chat not found", "message is too long", "not enough rights to send text messages"],
  revokedCode: "Unauthorized",
});

const CHAT = "-1001234567890";
const now = () => new Date("2026-11-27T00:00:00Z");

let sim: TelegramSimulator;
beforeEach(async () => {
  sim = await startTelegramSimulator();
});
afterEach(async () => {
  const unused = sim.faults.pending();
  await sim.close();
  expect(unused, "a fault was armed and no request used it").toBe(0);
});

// The adapter talks to api.telegram.org; the harness points that host at the simulator and keeps the path, which holds
// the token.
function harness(): MatrixHarness {
  const adapter = createTelegramAdapter();
  const account = { accessToken: new SealedSecret(sim.issueToken()), providerAccountId: CHAT };
  const send: typeof fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    return fetch(new URL(`${url.pathname}${url.search}`, sim.url), init);
  };
  const context: AdapterContext = { fetch: send, now };
  return {
    adapter: {
      ...adapter,
      commit: (given, input) => adapter.commit(given, { ...input, account }),
      delete: (given, post) => adapter.delete(given, { ...post, account }),
      edit: (given, post, input) => {
        if (!adapter.edit) throw new Error("the adapter has no edit");
        return adapter.edit(given, { ...post, account }, input);
      },
    },
    context,
    arm: sim.arm,
    effects: () => sim.effects(),
    settle: () => sim.settle(),
    stored: sim.stored,
    requestCount: () => sim.requests.length,
  };
}

describe("the Telegram simulator answers what a health check reads", () => {
  it.each([
    ["an administrator of a group the bot never saw", -1002, undefined, "ok"],
    ["a plain member of a channel", -1001, { status: "member" }, "degraded"],
  ])("%s", async (_name, chatId, member, health) => {
    sim.say({ id: -1001, type: "channel", title: "News" }, "hello");
    if (member) sim.setMember(chatId, member);
    const { context } = { context: harness().context };
    const result = await createTelegramAdapter().inspect(context, {
      accessToken: new SealedSecret(sim.issueToken()),
      providerAccountId: String(chatId),
    });
    expect(result).toMatchObject({ ok: true, health });
  });
});

describe("the Telegram provider passes the fault matrix", () => {
  it("declares a manifest the schema accepts, with text, image, edit and delete and no read-back", () => {
    expect(manifestSchema.parse(telegramManifest)).toMatchObject({
      capabilities: ["text", "image", "edit", "delete"],
      readBackMode: "E",
    });
  });

  it.each(rows.map((row): [string, FaultRow] => [row.id, row]))("row %s", async (_id, row) => {
    await row.run(harness());
  });
});
