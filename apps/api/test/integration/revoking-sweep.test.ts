import { createHash } from "node:crypto";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { channelProvidersOf } from "../../src/channels/credentials.js";
import { finishRevoking } from "../../src/jobs/ledger/revoking.js";
import { createLogger } from "../../src/logging/logger.js";
import { connectChannel, ledgerCredentials } from "../support/ledger-credentials.js";
import { seedWorkspace } from "../support/ledger-seed.js";

const env = readTestEnv();
let db: TestDatabase;
let ws: string;
const admin = <T>(run: Parameters<typeof withAdminClient<T>>[2]) => withAdminClient(env, db.name, run);
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  ws = await admin((client) => seedWorkspace(client));
});
afterAll(() => db.drop());

let revoked: string[] = [];
let failing = false;
const adapter = {
  ...createFixtureAdapter({ baseUrl: "http://127.0.0.1:1", clientId: "c" }),
  revoke: async () => {
    revoked.push("called");
    if (failing) throw new Error("the provider refused");
  },
};
const registry = createRegistry([fixtureManifest]);
const adapters = { [fixtureManifest.id]: adapter };
const logger = createLogger({ secrets: [], stream: { write: () => undefined } });

async function revoking(minutesAgo: number): Promise<string> {
  const account = createHash("sha256").update(`${minutesAgo}-${Math.random()}`).digest("hex").slice(0, 10);
  const channel = await connectChannel(db.pool("worker"), {
    workspace: ws,
    provider: fixtureManifest.id,
    account,
  });
  await admin((client) =>
    client.query(
      `UPDATE app.channel_credentials SET state = 'revoking', revoking_since = now() - make_interval(mins => $2)
       WHERE channel_id = $1`,
      [channel, minutesAgo],
    ),
  );
  return channel;
}
const stateOf = (channel: string) =>
  admin(
    async (client) =>
      (
        await client.query(
          "SELECT state, length(ciphertext) AS bytes FROM app.channel_credentials WHERE channel_id = $1",
          [channel],
        )
      ).rows[0],
  );
const sweep = () =>
  finishRevoking({
    pool: db.pool("worker"),
    credentials: ledgerCredentials(db.pool("worker"), { registry, adapters }),
    providers: channelProvidersOf(registry, adapters),
    logger,
  });

describe("the recovery sweep for a credential left revoking", () => {
  it("revokes once and destroys one left over ten minutes, and leaves a younger one alone", async () => {
    revoked = [];
    const [old, young] = [await revoking(11), await revoking(3)];
    expect(await sweep()).toBe(1);
    expect(revoked).toEqual(["called"]);
    expect(await stateOf(old)).toEqual({ state: "destroyed", bytes: 0 });
    expect((await stateOf(young))?.state).toBe("revoking");
    expect(await sweep()).toBe(0);
    expect(revoked).toEqual(["called"]);
  });

  it("destroys it even when the provider refuses", async () => {
    revoked = [];
    failing = true;
    try {
      const old = await revoking(30);
      await sweep();
      expect(revoked).toEqual(["called"]);
      expect(await stateOf(old)).toEqual({ state: "destroyed", bytes: 0 });
    } finally {
      failing = false;
    }
  });
});
