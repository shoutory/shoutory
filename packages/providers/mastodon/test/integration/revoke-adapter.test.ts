import { SealedSecret } from "@shoutory/core/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMastodonAdapter } from "../../src/adapter.js";
import { type MastodonSimulator, startMastodonSimulator } from "../../src/simulator.js";
import { HOST, recorder } from "../support/instance.js";

let sim: MastodonSimulator;
beforeAll(async () => {
  sim = await startMastodonSimulator({ now: () => new Date() });
});
afterAll(() => sim.close());

const adapter = createMastodonAdapter();

async function registered(context: ReturnType<typeof recorder>["context"]) {
  const connect = adapter.connect;
  if (!connect?.registerApp) throw new Error("the adapter has no registerApp");
  const made = await connect.registerApp(context, {
    instanceHost: HOST,
    redirectUri: "https://app.example.test/callback",
  });
  if (!made.app) throw new Error("the app was not registered");
  return made.app;
}

describe("revoke of an access token", () => {
  it("posts the app and the token to the account's own host only, and the token stops working", async () => {
    sim.reset();
    const { context, seen } = recorder(sim);
    const app = await registered(context);
    const token = sim.issueToken();
    seen.length = 0;
    if (!adapter.revoke) throw new Error("the adapter has no revoke");
    await adapter.revoke(context, { accessToken: new SealedSecret(token), instanceHost: HOST, app });
    expect(seen.map(({ host, method, path }) => [host, method, path])).toEqual([
      [HOST, "POST", "/oauth/revoke"],
    ]);
    expect(sim.tokens).not.toContain(token);
  });

  it("throws when the instance refuses it, and says only the status", async () => {
    sim.reset();
    const { context } = recorder(sim);
    const app = await registered(context);
    if (!adapter.revoke) throw new Error("the adapter has no revoke");
    const wrongApp = { ...app, clientSecret: new SealedSecret("not-the-secret-of-the-app") };
    const refused = adapter.revoke(context, {
      accessToken: new SealedSecret(sim.issueToken()),
      instanceHost: HOST,
      app: wrongApp,
    });
    await expect(refused).rejects.toThrow(/403/);
    await expect(refused).rejects.not.toThrow(/not-the-secret-of-the-app/);
  });

  it("needs the instance host and the app", async () => {
    const { context } = recorder(sim);
    if (!adapter.revoke) throw new Error("the adapter has no revoke");
    await expect(adapter.revoke(context, { accessToken: new SealedSecret("token-1") })).rejects.toThrow(
      /instance host/,
    );
  });
});
