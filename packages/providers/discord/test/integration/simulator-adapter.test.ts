import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDiscordAdapter } from "../../src/adapter.js";
import { type DiscordSimulator, startDiscordSimulator } from "../../src/simulator.js";
import { accountOf, recorder } from "../support/webhook.js";

let sim: DiscordSimulator;
beforeAll(async () => {
  sim = await startDiscordSimulator();
});
afterAll(() => sim.close());

const adapter = createDiscordAdapter();

// The simulator parses the multipart body the way the reference documents it, so a body Discord would refuse fails here.
describe("a send with files against the simulator", () => {
  it("delivers each file under its position with its alt text, and one message", async () => {
    sim.reset();
    const { context } = recorder(sim);
    const media = {
      items: [{ mime: "image/png", size: 4, altText: "a cat" }],
      read: async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), altText: "a cat" }),
    };
    const answer = await adapter.commit(
      { ...context, media },
      { idempotencyKey: "files-1", text: "hello", account: accountOf(sim.urlFor()), mediaIds: ["file-0"] },
    );
    expect(answer).toMatchObject({ ok: true, effect: "confirmed" });
    expect(sim.stored().map((message) => message.text)).toEqual(["hello"]);
    expect(sim.files()).toEqual([
      { filename: "file-0.png", bytes: Buffer.from([1, 2, 3, 4]), description: "a cat" },
    ]);
  });
});
