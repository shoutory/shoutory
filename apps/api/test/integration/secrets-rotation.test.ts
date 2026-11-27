import { randomBytes, randomUUID } from "node:crypto";
import { type Aad, EnvelopeError, NIL_SCOPE, open, type StoredSecret, seal } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { withTenant } from "@shoutory/db/context";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { readApp } from "../../src/channels/instance-app.js";
import { run } from "../../src/cli/main.js";
import { emailLinkAad } from "../../src/mail/enqueue.js";
import { leaks } from "../support/canary.js";

// One rotation from k1 to k2 across every sealed table, through the CLI an operator runs.
const env = readTestEnv();
const KEK = (n: number) => Buffer.alloc(32, n).toString("base64");
const OLD = new EnvKeyProvider({ SHOUTORY_ACTIVE_KEY_ID: "k1", SHOUTORY_KEK_K1: KEK(1) });
const NEW = new EnvKeyProvider({ SHOUTORY_ACTIVE_KEY_ID: "k2", SHOUTORY_KEK_K2: KEK(2) });
const ROTATED = { SHOUTORY_ACTIVE_KEY_ID: "k2", SHOUTORY_KEK_K1: KEK(1), SHOUTORY_KEK_K2: KEK(2) };
const RETIRED = { SHOUTORY_ACTIVE_KEY_ID: "k2", SHOUTORY_KEK_K2: KEK(2) };
const TOKEN = "rotation-token-canary-1";
const CLIENT_SECRET = "rotation-client-secret-canary-1";
const VERIFIER = "rotation-verifier-canary-1";
const LINK = "https://app.example.test/auth/verify#token=rotation-link-canary-1";
const CANARIES = [TOKEN, CLIENT_SECRET, VERIFIER, LINK];
const WS = randomUUID();
const OTHER_WS = randomUUID();
const USER = randomUUID();
const HOST = "rotation.example.test";
const PROVIDER = "fixture_oauth";
const SCOPES = "read write";

let db: TestDatabase;
const salts = new Map<string, Buffer>();
const sql = async (text: string, params: unknown[] = []) =>
  withAdminClient(env, db.name, async (admin) => (await admin.query(text, params)).rows);

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await sql(`INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, 'rotation', $2, true)`, [
    USER,
    "rotation-1@example.test",
  ]);
  const [org] = await sql(
    "INSERT INTO app.organizations (name, slug, type) VALUES ('rotation', 'rotation', 'team') RETURNING id",
  );
  for (const [workspace, slug] of [
    [WS, "rotation-a"],
    [OTHER_WS, "rotation-b"],
  ] as const) {
    await sql("INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, $3, $3)", [
      workspace,
      org?.id,
      slug,
    ]);
    const [salt] = await sql(
      "INSERT INTO app.workspace_key_salts (workspace_id, salt) VALUES ($1, $2) RETURNING salt",
      [workspace, randomBytes(32)],
    );
    salts.set(workspace, salt?.salt as Buffer);
  }
  await sql(
    `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
     SELECT $1, $2, r.id FROM app.roles AS r WHERE r.workspace_id IS NULL AND r.key = 'owner'`,
    [WS, USER],
  );
});
afterAll(() => db.drop());

const fresh = () =>
  sql(`DELETE FROM app.channel_credentials; DELETE FROM app.channels; DELETE FROM app.provider_instance_apps;
       DELETE FROM app.provider_apps;
       DELETE FROM app.oauth_flows; DELETE FROM app.email_outbox`);

const sealedColumns = (s: StoredSecret) => [
  s.formatVersion,
  s.keyId,
  s.iv,
  s.ciphertext,
  s.tag,
  s.wrapIv,
  s.wrapTag,
  s.wrappedDek,
];
const storedOf = (row: Record<string, unknown>, prefix = ""): StoredSecret => ({
  formatVersion: row[`${prefix}format_version`] as number,
  keyId: row[`${prefix}key_id`] as string,
  iv: row[`${prefix}iv`] as Buffer,
  ciphertext: row[`${prefix}ciphertext`] as Buffer,
  tag: row[`${prefix}auth_tag`] as Buffer,
  wrapIv: row[`${prefix}wrap_iv`] as Buffer,
  wrapTag: row[`${prefix}wrap_tag`] as Buffer,
  wrappedDek: row[`${prefix}wrapped_dek`] as Buffer,
});
const aadOf = (scopeId: string, ownerId: string, credentialKind: Aad["credentialKind"], generation: number) =>
  ({ formatVersion: 1, scopeId, ownerId, credentialKind, generation }) as const;

interface Planted {
  kind?: string;
  leaseSeconds?: number;
}
/** Plants a channel with its sealed token, as the connect flow stores it; returns the channel id. */
type Admin = Parameters<Parameters<typeof withAdminClient>[2]>[0];
async function plantCredential(admin: Admin, o: Planted = {}): Promise<string> {
  const channel = randomUUID();
  await admin.query(
    `INSERT INTO app.channels (id, workspace_id, provider_id, account_kind, provider_account_id, display_name,
       connection_state)
     VALUES ($1::uuid, $2, $3, 'profile', $1::text, 'rotation channel', 'connected')`,
    [channel, WS, PROVIDER],
  );
  const sealed = seal(TOKEN, aadOf(WS, channel, "channel_token", 1), OLD, salts.get(WS));
  await admin.query(
    `INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv,
       ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, refreshing_until, refresh_owner)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       CASE WHEN $12::int IS NULL THEN NULL ELSE clock_timestamp() + make_interval(secs => $12::int) END,
       CASE WHEN $12::int IS NULL THEN NULL ELSE 'refresher-1' END)`,
    [WS, channel, o.kind ?? "channel_token", ...sealedColumns(sealed), o.leaseSeconds ?? null],
  );
  return channel;
}
const plantOne = (o: Planted = {}) => withAdminClient(env, db.name, (admin) => plantCredential(admin, o));

async function plantInstanceApp(): Promise<string> {
  const id = randomUUID();
  const sealed = seal(CLIENT_SECRET, aadOf(NIL_SCOPE, id, "provider_instance_app", 1), OLD);
  await sql(
    `INSERT INTO app.provider_instance_apps (id, provider_id, instance_host, scopes, client_id, secret_format_version,
       secret_key_id, secret_iv, secret_ciphertext, secret_auth_tag, secret_wrap_iv, secret_wrap_tag,
       secret_wrapped_dek, secret_generation)
     VALUES ($1, $2, $3, $4, 'client-rotation-1', $5, $6, $7, $8, $9, $10, $11, $12, 1)`,
    [id, PROVIDER, HOST, SCOPES, ...sealedColumns(sealed)],
  );
  return id;
}

async function plantProviderApp(): Promise<string> {
  const id = randomUUID();
  const sealed = seal(CLIENT_SECRET, aadOf(NIL_SCOPE, id, "provider_instance_app", 1), OLD);
  await sql(
    `INSERT INTO app.provider_apps (id, provider_id, environment, client_id, redirect_uri, secret_format_version,
       secret_key_id, secret_iv, secret_ciphertext, secret_auth_tag, secret_wrap_iv, secret_wrap_tag,
       secret_wrapped_dek, secret_generation)
     VALUES ($1, $2, 'production', 'client-rotation-2', 'https://app.example.test/x', $3, $4, $5, $6, $7, $8, $9, $10, 1)`,
    [id, PROVIDER, ...sealedColumns(sealed)],
  );
  return id;
}

async function plantFlowAndLink(): Promise<void> {
  const flow = randomUUID();
  const verifier = JSON.stringify({ code_verifier: VERIFIER });
  const sealedFlow = seal(verifier, aadOf(WS, flow, "oauth_flow", 1), OLD, salts.get(WS));
  await sql(
    `INSERT INTO app.oauth_flows (id, workspace_id, user_id, provider_id, state_hash, format_version, key_id, iv,
       ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + interval '10 minutes')`,
    [flow, WS, USER, PROVIDER, randomBytes(32), ...sealedColumns(sealedFlow)],
  );
  const mail = randomUUID();
  const link = seal(LINK, emailLinkAad(mail, null, 0), OLD);
  await sql(
    `INSERT INTO app.email_outbox (id, recipient, template, locale, vars, link_format_version, link_key_id, link_iv,
       link_ciphertext, link_auth_tag, link_wrap_iv, link_wrap_tag, link_wrapped_dek, link_generation, link_digest)
     VALUES ($1, 'rotation-1@example.test', 'verify_email', 'en', '{}', $2, $3, $4, $5, $6, $7, $8, $9, 0, $10)`,
    [mail, ...sealedColumns(link), "d".repeat(64)],
  );
}

function command(argv: string[], keys: Record<string, string>) {
  const out: string[] = [];
  const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => out.push(line) };
  const done = run(argv, { SHOUTORY_DATABASE_URL_WORKER: db.url("worker"), ...keys }, io);
  return { done, text: () => out.join("\n") };
}
const exitOf = (argv: string[], keys: Record<string, string>) => command(argv, keys).done;
const credentialOf = async (channel: string) =>
  (await sql("SELECT * FROM app.channel_credentials WHERE channel_id = $1", [channel]))[0] ?? {};

describe("a key rotation", () => {
  let channel = "";
  let appId = "";
  let providerAppId = "";
  beforeAll(async () => {
    await fresh();
    channel = await plantOne();
    appId = await plantInstanceApp();
    providerAppId = await plantProviderApp();
    await plantFlowAndLink();
  });

  it("is retired only after reseal moved email, credential and instance app rows and the last flow is purged", async () => {
    const stale = command(["secrets", "check"], ROTATED);
    expect(await stale.done).toBe(1);
    expect(stale.text()).toMatch(/not active.*k1/i);
    const reseal = command(["secrets", "reseal"], ROTATED);
    expect(await reseal.done).toBe(0);
    expect(leaks(`${stale.text()}\n${reseal.text()}`, CANARIES)).toEqual([]);
    // A flow is never resealed: it lives ten minutes, and the key stays listed until the purge took it.
    expect(await exitOf(["secrets", "check"], ROTATED)).toBe(1);
    await sql("DELETE FROM app.oauth_flows");
    expect(await exitOf(["secrets", "check"], RETIRED)).toBe(0);
  });

  it("leaves the token and the client secret readable with the old key gone, each one generation on", async () => {
    const row = await credentialOf(channel);
    expect([row.key_id, row.generation]).toEqual(["k2", 2]);
    expect(open(storedOf(row), aadOf(WS, channel, "channel_token", 2), NEW, salts.get(WS)).expose()).toBe(
      TOKEN,
    );
    const app = await withTenant(db.pool("app"), { principalKind: "user", principalId: USER }, (tx) =>
      readApp(tx, NEW, { workspaceId: WS, providerId: PROVIDER, instanceHost: HOST, scopes: SCOPES }),
    );
    expect(app?.clientSecret.expose()).toBe(CLIENT_SECRET);
    const [stored] = await sql("SELECT secret_generation FROM app.provider_instance_apps WHERE id = $1", [
      appId,
    ]);
    expect(stored?.secret_generation).toBe(2);
    const [provider] = await sql("SELECT * FROM app.provider_apps WHERE id = $1", [providerAppId]);
    expect([provider?.secret_key_id, provider?.secret_generation]).toEqual(["k2", 2]);
    const aad = aadOf(NIL_SCOPE, providerAppId, "provider_instance_app", 2);
    expect(open(storedOf(provider ?? {}, "secret_"), aad, NEW).expose()).toBe(CLIENT_SECRET);
  });
});

describe("a resealed row is bound to its owner", () => {
  let channel = "";
  let appId = "";
  beforeAll(async () => {
    await fresh();
    channel = await plantOne();
    appId = await plantInstanceApp();
    expect(await exitOf(["secrets", "reseal"], ROTATED)).toBe(0);
  });

  it.each([
    ["the token under another channel", () => randomUUID(), 2, WS],
    ["the token under another workspace's salt", () => channel, 2, OTHER_WS],
    ["the token under its old generation", () => channel, 1, WS],
  ])("refuses to open %s", async (_case, owner, generation, saltOf) => {
    const stored = storedOf(await credentialOf(channel));
    const own = aadOf(WS, channel, "channel_token", 2);
    expect(open(stored, own, NEW, salts.get(WS)).expose()).toBe(TOKEN);
    const aad = aadOf(WS, owner(), "channel_token", generation);
    expect(() => open(stored, aad, NEW, salts.get(saltOf))).toThrow(EnvelopeError);
  });

  it("refuses to open the client secret under another row id", async () => {
    const [row] = await sql("SELECT * FROM app.provider_instance_apps WHERE id = $1", [appId]);
    const stored = storedOf(row ?? {}, "secret_");
    expect(open(stored, aadOf(NIL_SCOPE, appId, "provider_instance_app", 2), NEW).expose()).toBe(
      CLIENT_SECRET,
    );
    const aad = aadOf(NIL_SCOPE, randomUUID(), "provider_instance_app", 2);
    expect(() => open(stored, aad, NEW)).toThrow(EnvelopeError);
  });
});

describe("a reseal that cannot finish every row", () => {
  it("counts a row under a live refresh lease as busy, exits 0, and moves it on a rerun after the lease ends", async () => {
    await fresh();
    const channel = await plantOne({ leaseSeconds: 60 });
    const first = command(["secrets", "reseal"], ROTATED);
    expect(await first.done).toBe(0);
    expect(first.text()).toContain("busy: 1");
    expect((await credentialOf(channel)).key_id).toBe("k1");
    expect(await exitOf(["secrets", "check"], ROTATED)).toBe(1);
    await sql(
      "UPDATE app.channel_credentials SET refreshing_until = clock_timestamp() - interval '1 second'",
    );
    expect(await exitOf(["secrets", "reseal"], ROTATED)).toBe(0);
    expect(await exitOf(["secrets", "check"], RETIRED)).toBe(0);
  });

  it("skips a row of a kind it cannot seal, counts it by key id, exits 1 and keeps the key listed", async () => {
    await fresh();
    await plantOne({ kind: "bot_token" });
    const result = command(["secrets", "reseal"], ROTATED);
    expect(await result.done).toBe(1);
    expect(result.text()).toContain("skipped 1 sealed under k1");
    expect(leaks(result.text(), CANARIES)).toEqual([]);
    expect(await exitOf(["secrets", "check"], ROTATED)).toBe(1);
  });

  it("stopped after its first batch and run again, leaves every row under the new key", async () => {
    await fresh();
    await withAdminClient(env, db.name, async (admin) => {
      for (let n = 0; n < 101; n += 1) await plantCredential(admin);
      await admin.query(`CREATE SEQUENCE app.rotation_writes;
        CREATE FUNCTION app.rotation_stop() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
        BEGIN IF nextval('app.rotation_writes') > 100 THEN RAISE EXCEPTION 'stopped'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER rotation_stop BEFORE UPDATE ON app.channel_credentials
          FOR EACH ROW EXECUTE FUNCTION app.rotation_stop()`);
    });
    try {
      expect(await exitOf(["secrets", "reseal"], ROTATED)).toBe(1);
      const [moved] = await sql("SELECT count(*)::int AS n FROM app.channel_credentials WHERE key_id = 'k2'");
      expect(moved?.n).toBe(100);
    } finally {
      await sql(`DROP TRIGGER rotation_stop ON app.channel_credentials; DROP FUNCTION app.rotation_stop();
                 DROP SEQUENCE app.rotation_writes`);
    }
    expect(await exitOf(["secrets", "reseal"], ROTATED)).toBe(0);
    expect(await exitOf(["secrets", "check"], RETIRED)).toBe(0);
  });
});
