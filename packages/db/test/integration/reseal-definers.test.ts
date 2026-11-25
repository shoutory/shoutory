import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { seedMembers, U, WA, WB } from "../support/members-seed.js";

const env = readTestEnv();

// Rows are planted as the superuser with random bytes: the definers only move sealed bytes, they never open them.
let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = async (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);
const asWorker = async (sql: string, params: unknown[] = []) =>
  (await db.pool("worker").query(sql, params)).rows;
const sealedBytes = () => [12, 48, 16, 12, 16, 48].map((n) => randomBytes(n));

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(seedMembers);
  for (const workspace of [WA, WB])
    await rows("INSERT INTO app.workspace_key_salts (workspace_id, salt) VALUES ($1, $2)", [
      workspace,
      randomBytes(32),
    ]);
});
afterAll(() => db.drop());

async function plantChannel(workspace: string): Promise<string> {
  const id = randomUUID();
  await rows(
    `INSERT INTO app.channels (id, workspace_id, provider_id, account_kind, provider_account_id, display_name,
       connection_state)
     VALUES ($1::uuid, $2, 'fixture_oauth', 'profile', $1::text, 'reseal channel', 'connected')`,
    [id, workspace],
  );
  return id;
}

interface Credential {
  keyId?: string;
  state?: string;
  kind?: string;
  generation?: number;
  /** A lease that ends this many seconds from now; negative is an expired lease. */
  leaseSeconds?: number | undefined;
  outcome?: string | undefined;
}
async function plantCredential(workspace: string, o: Credential = {}): Promise<string> {
  const channel = await plantChannel(workspace);
  const [found] = await rows(
    `INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv,
       ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, state, refreshing_until, refresh_owner,
       refresh_attempt_outcome)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12,
       CASE WHEN $13::int IS NULL THEN NULL ELSE clock_timestamp() + make_interval(secs => $13::int) END,
       CASE WHEN $13::int IS NULL THEN NULL ELSE 'refresher-1' END, $14)
     RETURNING id`,
    [
      workspace,
      channel,
      o.generation ?? 1,
      o.kind ?? "channel_token",
      o.keyId ?? "k1",
      ...sealedBytes(),
      o.state ?? "active",
      o.leaseSeconds ?? null,
      o.outcome ?? null,
    ],
  );
  return String(found?.id);
}

async function plantInstanceApp(keyId: string, generation = 1): Promise<string> {
  const [found] = await rows(
    `INSERT INTO app.provider_instance_apps (provider_id, instance_host, client_id, secret_iv, secret_ciphertext,
       secret_auth_tag, secret_wrap_iv, secret_wrap_tag, secret_wrapped_dek, secret_key_id, secret_format_version,
       secret_generation)
     VALUES ('fixture_oauth', $1, 'client-reseal-1', $2, $3, $4, $5, $6, $7, $8, 1, $9) RETURNING id`,
    [`${randomUUID()}.example.test`, ...sealedBytes(), keyId, generation],
  );
  return String(found?.id);
}

async function plantProviderApp(keyId: string): Promise<void> {
  await rows(
    `INSERT INTO app.provider_apps (provider_id, environment, client_id, redirect_uri, active, secret_iv,
       secret_ciphertext, secret_auth_tag, secret_wrap_iv, secret_wrap_tag, secret_wrapped_dek, secret_key_id,
       secret_format_version, secret_generation)
     VALUES ('fixture_oauth', 'sandbox', 'client-reseal-2', 'https://app.example.test/cb', false, $1, $2, $3, $4,
       $5, $6, $7, 1, 1)`,
    [...sealedBytes(), keyId],
  );
}

async function plantFlow(keyId: string, consumed: boolean): Promise<void> {
  await rows(
    `INSERT INTO app.oauth_flows (workspace_id, user_id, provider_id, state_hash, format_version, key_id, iv,
       ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, expires_at, consumed_at)
     VALUES ($1, $2, 'fixture_oauth', $3, 1, $4, $5, $6, $7, $8, $9, $10, now() + interval '10 minutes',
       CASE WHEN $11 THEN now() END)`,
    [WA, U.admin, randomBytes(32), keyId, ...sealedBytes(), consumed],
  );
}

const listed = async () => (await asWorker("SELECT key_id FROM app.sealed_key_ids()")).map((r) => r.key_id);
const credential = async (id: string) =>
  (await rows("SELECT * FROM app.channel_credentials WHERE id = $1", [id]))[0];
const channelOfCredential = async (id: string) =>
  (
    await rows(
      `SELECT c.* FROM app.channels AS c JOIN app.channel_credentials AS k ON k.channel_id = c.id WHERE k.id = $1`,
      [id],
    )
  )[0];
const writeArgs = (id: string, expected: number) => {
  const [iv, ciphertext, tag, wrapIv, wrapTag, dek] = sealedBytes();
  return [id, expected, ciphertext, iv, tag, wrapIv, wrapTag, dek, "k2", 1];
};
const TEN = "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10";

describe("sealed_key_ids", () => {
  it("lists the key of an instance app, a provider app, a flow (consumed or not) and a credential in any state", async () => {
    await plantInstanceApp("ia-key");
    await plantProviderApp("pa-key");
    await plantFlow("flow-open", false);
    await plantFlow("flow-spent", true);
    for (const state of ["active", "read_only", "superseded", "destroyed"])
      await plantCredential(WA, { keyId: `cred-${state.replace("_", "-")}`, state });
    expect(await listed()).toEqual(
      expect.arrayContaining([
        "ia-key",
        "pa-key",
        "flow-open",
        "flow-spent",
        "cred-active",
        "cred-read-only",
        "cred-superseded",
        "cred-destroyed",
      ]),
    );
  });

  it("reads every app column named key_id or *_key_id, so a new sealed table cannot be left out", async () => {
    const columns = await rows(
      `SELECT c.table_name, c.column_name FROM information_schema.columns AS c
         JOIN information_schema.tables AS t USING (table_schema, table_name)
        WHERE c.table_schema = 'app' AND t.table_type = 'BASE TABLE'
          AND (c.column_name = 'key_id' OR c.column_name LIKE '%\\_key\\_id')`,
    );
    const [definition] = await rows("SELECT pg_get_functiondef('app.sealed_key_ids'::regproc) AS body");
    const body = String(definition?.body);
    const unread = columns.filter(
      (c) => !new RegExp(`\\.${c.column_name}\\s+FROM\\s+app\\.${c.table_name}\\b`).test(body),
    );
    expect(columns.length).toBeGreaterThanOrEqual(5);
    expect(unread).toEqual([]);
  });
});

describe("channel_credentials_reseal_batch", () => {
  it("returns rows of any state not under the active key, after the cursor, each with its own workspace salt", async () => {
    await rows("DELETE FROM app.channel_credentials");
    const a = await plantCredential(WA, { keyId: "k1", state: "superseded" });
    const b = await plantCredential(WB, { keyId: "k1" });
    await plantCredential(WA, { keyId: "k2" });
    const found = await asWorker(
      "SELECT * FROM app.channel_credentials_reseal_batch(10, 'k2', NULL) ORDER BY id",
    );
    expect(found.map((r) => r.id)).toEqual([a, b].sort());
    const salts = await rows("SELECT workspace_id, salt FROM app.workspace_key_salts");
    for (const row of found)
      expect(row.salt).toEqual(salts.find((s) => s.workspace_id === row.workspace_id)?.salt);
    const after = await asWorker("SELECT id FROM app.channel_credentials_reseal_batch(10, 'k2', $1)", [
      found[0]?.id,
    ]);
    expect(after.map((r) => r.id)).toEqual([found[1]?.id]);
  });

  it.each([0, 501])("refuses a limit of %i", async (lim) => {
    await expect(
      asWorker("SELECT * FROM app.channel_credentials_reseal_batch($1, 'k2', NULL)", [lim]),
    ).rejects.toMatchObject({ code: "22023" });
  });
});

describe("channel_credentials_reseal_write", () => {
  it.each([
    ["no lease", "resealed", undefined, 0, undefined],
    ["an expired lease", "resealed", -60, 0, "failed"],
    ["a live refresh lease", "busy", 60, 0, undefined],
    ["an expired lease whose refresh outcome is unknown", "busy", -60, 0, "unknown"],
    ["a generation changed since the read", "busy", undefined, 1, undefined],
  ])(
    "with %s answers %s and never touches the channel",
    async (_case, outcome, leaseSeconds, drift, last) => {
      const id = await plantCredential(WA, {
        leaseSeconds,
        generation: 3,
        state: "read_only",
        outcome: last,
      });
      const channelBefore = await channelOfCredential(id);
      const before = await credential(id);
      const [answer] = await asWorker(
        `SELECT app.channel_credentials_reseal_write(${TEN}) AS outcome`,
        writeArgs(id, 3 - drift),
      );
      expect(answer?.outcome).toBe(outcome);
      const after = await credential(id);
      expect(await channelOfCredential(id)).toEqual(channelBefore);
      expect(after?.state).toBe("read_only");
      if (outcome === "resealed") {
        expect([after?.key_id, after?.generation]).toEqual(["k2", 4]);
        expect(after?.ciphertext).not.toEqual(before?.ciphertext);
      } else expect(after).toEqual(before);
    },
  );
});

describe("instance_apps_reseal", () => {
  it("the batch returns the generation and the write bumps it, refusing a stale one", async () => {
    await rows("DELETE FROM app.provider_instance_apps");
    const id = await plantInstanceApp("k1", 2);
    const [found] = await asWorker("SELECT * FROM app.instance_apps_reseal_batch(10, 'k2', NULL)");
    expect([found?.id, found?.secret_generation]).toEqual([id, 2]);
    const stale = await asWorker(
      `SELECT app.instance_apps_reseal_write(${TEN}) AS written`,
      writeArgs(id, 1),
    );
    expect(stale[0]?.written).toBe(false);
    const done = await asWorker(`SELECT app.instance_apps_reseal_write(${TEN}) AS written`, writeArgs(id, 2));
    expect(done[0]?.written).toBe(true);
    const [after] = await rows("SELECT secret_key_id, secret_generation FROM app.provider_instance_apps");
    expect(after).toEqual({ secret_key_id: "k2", secret_generation: 3 });
  });
});
