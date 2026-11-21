import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { cloneTemplate, readTestEnv, type TestDatabase } from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/logging/logger.js";
import { testAuth } from "../support/auth.js";

const env = readTestEnv();
const REMOTE = { incoming: { socket: { remoteAddress: "192.0.2.1" } } };
const ORIGIN = "https://app.example.test";
const lines: string[] = [];
const logger = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
const keys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});

let db: TestDatabase;
let owner: ReturnType<TestDatabase["pool"]>;
let app: ReturnType<typeof createApp>;
let appPool: ReturnType<typeof createAppPool>;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  owner = db.pool("owner");
  // A ready answer needs a worker that has beaten (R315).
  await db.pool("worker").query("SELECT app.worker_heartbeat('readiness-partitions-worker', 'worker')");
  appPool = createAppPool(db.url("app"), () => undefined);
  app = createApp({
    publicOrigin: ORIGIN,
    trustedProxies: [],
    pool: appPool,
    keys,
    logger,
    auth: testAuth(appPool, keys, logger, ORIGIN),
  });
});
afterAll(async () => {
  await appPool.end();
  await db.drop();
});

const ready = async () => {
  lines.length = 0;
  const answer = await Promise.resolve(app.request("/readyz", {}, REMOTE));
  // The cause is in the log only (R494).
  return [answer.status, /"cause":"([a-z_]+)"/.exec(lines.join("\n"))?.[1]];
};
const leaf = (name: string, from: string, to: string) =>
  owner.query(
    `CREATE TABLE app.${name} PARTITION OF app.partition_fixture FOR VALUES FROM ('${from}') TO ('${to}')`,
  );

describe("/readyz and the partition runway (NFR-REL-08)", () => {
  it("is not ready with fewer than two future partitions of any time-partitioned table", async () => {
    // The first partitioned table (the audit log) has its runway: the probe is ready.
    expect(await ready()).toEqual([200, undefined]);
    await owner.query("CREATE TABLE app.partition_fixture (at timestamptz NOT NULL) PARTITION BY RANGE (at)");
    await leaf("partition_fixture_past", "2000-01-01", "2000-02-01");
    await leaf("partition_fixture_next", "2999-01-01", "2999-02-01");
    // One future leaf and a past one: not ready, whichever table lacks the runway.
    expect(await ready()).toEqual([503, "partitions_short"]);
    await leaf("partition_fixture_after", "2999-02-01", "2999-03-01");
    expect(await ready()).toEqual([200, undefined]);
  });

  it("does not count a hash-partitioned table: it has no time runway to run out", async () => {
    await owner.query("CREATE TABLE app.hash_fixture (id int NOT NULL) PARTITION BY HASH (id)");
    await owner.query(
      "CREATE TABLE app.hash_fixture_0 PARTITION OF app.hash_fixture FOR VALUES WITH (MODULUS 1, REMAINDER 0)",
    );
    expect(await ready()).toEqual([200, undefined]);
  });
});
