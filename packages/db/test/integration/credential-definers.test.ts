import { randomBytes, randomUUID } from "node:crypto";
import { EnvelopeError, open, seal } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, commitAs, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();

// Rows are planted and leases are backdated as the superuser; nothing sleeps.
let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);
const call = (name: string, params: unknown[]): [string, unknown[]] => [
  `SELECT * FROM app.${name}(${params.map((_, index) => `$${index + 1}`).join(", ")})`,
  params,
];
const AS_ADMIN = asUser(U.admin);
async function run(
  ctx: TenantCtx,
  [sql, params]: [string, unknown[]],
  pool: "app" | "worker" = "app",
): Promise<Record<string, unknown>[]> {
  const client = await openTx(db.pool(pool), ctx);
  try {
    const result = (await client.query(sql, params)).rows;
    await client.query("COMMIT");
    return result;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const sealed = () => [
  1,
  "k1",
  randomBytes(12),
  randomBytes(48),
  randomBytes(16),
  randomBytes(12),
  randomBytes(16),
  randomBytes(48),
];
const FIRST = { manifest: "digest-a", api: "v1", capabilities: { text: true }, limits: { text: 280 } };
const in1h = () => new Date(Date.now() + 3_600_000);

async function plantChannel(workspace: string, state = "connected"): Promise<string> {
  const id = randomUUID();
  await rows(
    `INSERT INTO app.channels (id, workspace_id, provider_id, account_kind, provider_account_id, display_name,
       connection_state, state_reason, reconnect_deadline)
     VALUES ($1::uuid, $2, 'fixture_oauth', 'profile', $1::text, 'credential channel', $3::text,
       CASE WHEN $3::text = 'disabled' THEN 'admin_disabled' END,
       CASE WHEN $3::text = 'disabled' THEN now() + interval '10 days' END)`,
    [id, workspace, state],
  );
  return id;
}

interface Planted {
  digest?: string | null;
  generation?: number;
  state?: string;
  /** null plants a token with no expiry. */
  accessExpiresIn?: string | null;
  refreshExpiresIn?: string | null;
  keyId?: string;
}
async function plantCredential(workspace: string, channel: string, o: Planted = {}): Promise<void> {
  const [format, , iv, ciphertext, tag, wrapIv, wrapTag, dek] = sealed();
  await rows(
    `INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv,
       ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, access_expires_at, refresh_expires_at,
       refresh_token_digest, state)
     VALUES ($1, $2, $3, 'channel_token', $4, $5, $6, $7, $8, $9, $10, $11, now() + $12::interval,
       CASE WHEN $13::text IS NULL THEN NULL ELSE now() + $13::interval END, $14, $15)`,
    [
      workspace,
      channel,
      o.generation ?? 1,
      format,
      o.keyId ?? "k1",
      iv,
      ciphertext,
      tag,
      wrapIv,
      wrapTag,
      dek,
      o.accessExpiresIn === undefined ? "1 hour" : o.accessExpiresIn,
      o.refreshExpiresIn ?? null,
      o.digest === undefined ? "digest-1" : o.digest,
      o.state ?? "active",
    ],
  );
}
const credentialOf = async (channel: string) =>
  (await rows("SELECT * FROM app.channel_credentials WHERE channel_id = $1", [channel]))[0];
const channelOf = async (channel: string) =>
  (await rows("SELECT * FROM app.channels WHERE id = $1", [channel]))[0];
const expireLease = (channel: string) =>
  rows(
    "UPDATE app.channel_credentials SET refreshing_until = clock_timestamp() - interval '1 second' WHERE channel_id = $1",
    [channel],
  );

type Build = (ws: string, ch: string, bare: string) => [string, unknown[]];
const DEFINER_CALLS: [string, Build][] = [
  ["workspace_salt_ensure", (ws) => call("workspace_salt_ensure", [ws, randomBytes(32)])],
  [
    "channel_connect",
    (ws) =>
      call("channel_connect", [
        ws,
        "fixture_oauth",
        "profile",
        randomUUID(),
        null,
        "Account",
        null,
        null,
        null,
        "req-c",
        null,
      ]),
  ],
  [
    "credential_put",
    (ws, _ch, bare) =>
      call("credential_put", [
        ws,
        bare,
        0,
        ...sealed(),
        in1h(),
        null,
        "digest-9",
        FIRST.manifest,
        FIRST.api,
        null,
        JSON.stringify(FIRST.capabilities),
        JSON.stringify(FIRST.limits),
        "req-p",
        null,
      ]),
  ],
  ["credential_open", (ws, ch) => call("credential_open", [ws, ch])],
  ["credential_refresh_begin", (ws, ch) => call("credential_refresh_begin", [ws, ch, "worker-1", 60])],
  [
    "credential_refresh_commit",
    (ws, ch) =>
      call("credential_refresh_commit", [ws, ch, "digest-1", 1, 0, ...sealed(), in1h(), null, "digest-2"]),
  ],
  [
    "credential_refresh_fail",
    (ws, ch) => call("credential_refresh_fail", [ws, ch, "digest-1", 0, "failed", null]),
  ],
  [
    "channel_health_record",
    (ws, ch) =>
      call("channel_health_record", [
        ws,
        ch,
        "ok",
        FIRST.manifest,
        FIRST.api,
        null,
        JSON.stringify(FIRST.capabilities),
        JSON.stringify(FIRST.limits),
      ]),
  ],
];

const job = (workspaces: string[]): TenantCtx => ({
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: workspaces,
});
const SWEEP: TenantCtx = { principalKind: "job", jobPurpose: "credential_refresh" };
const PRINCIPALS: [string, () => TenantCtx, "app" | "worker", boolean][] = [
  ["a user Admin of the workspace", () => asUser(U.admin), "app", true],
  ["a job principal of the workspace", () => job([WA]), "worker", true],
  ["a user Editor (no channels.manage)", () => asUser(U.editor), "app", false],
  ["a job principal of another workspace", () => job([WB]), "worker", false],
  [
    "a service principal",
    () => ({
      principalKind: "service",
      serviceKind: "api_key",
      principalId: randomUUID(),
      workspaceIds: [WA],
      writeWorkspaceId: WA,
    }),
    "app",
    false,
  ],
  [
    "a portal principal",
    () => ({ principalKind: "portal", portalGrantId: randomUUID(), workspaceIds: [WA] }),
    "app",
    false,
  ],
];

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin((client) => seedMembers(client));
});
afterAll(() => db.drop());

describe("who may call a credential definer", () => {
  const cases = DEFINER_CALLS.flatMap(([name, build]) =>
    PRINCIPALS.map(([who, ctx, pool, accepted]) => ({ name, build, who, ctx, pool, accepted })),
  );
  it.each(cases)("$name as $who", async ({ build, ctx, pool, accepted }) => {
    const ch = await plantChannel(WA);
    await plantCredential(WA, ch);
    const [sql, params] = build(WA, ch, await plantChannel(WA));
    const result = await attempt(db.pool(pool), ctx(), sql, params);
    if (accepted) expect(result.error).toBeUndefined();
    else expect(result.error).toMatchObject({ code: "42501" });
  });

  it("a Workspace B Admin cannot open, begin, commit or fail a credential of Workspace A", async () => {
    const ch = await plantChannel(WA);
    await plantCredential(WA, ch);
    const asB = (name: string, params: unknown[]) =>
      attempt(db.pool("app"), asUser(U.bOwner), ...call(name, params));
    const refused = await Promise.all([
      asB("credential_open", [WA, ch]),
      asB("credential_refresh_begin", [WA, ch, "w", 60]),
      asB("credential_refresh_commit", [WA, ch, "digest-1", 1, 0, ...sealed(), in1h(), null, "digest-2"]),
      asB("credential_refresh_fail", [WA, ch, "digest-1", 0, "failed", null]),
      asB("credential_open", [WB, ch]),
    ]);
    expect(refused.map((r) => (r.error as { code?: string } | undefined)?.code ?? "no error")).toEqual([
      "42501",
      "42501",
      "42501",
      "42501",
      "no error",
    ]);
    // Asked through its own workspace, a channel of another workspace is simply not there.
    expect(refused[4]?.rows).toEqual([]);
  });
});

const connect = (ws: string, account: string, reconnect: string | null = null, user = U.admin) =>
  commitAs(
    db.pool("app"),
    user,
    ...call("channel_connect", [
      ws,
      "fixture_oauth",
      "profile",
      account,
      null,
      "Account",
      null,
      null,
      reconnect,
      "req-c",
      null,
    ]),
  );
const put = (ws: string, channel: string, expected: number, snapshot = FIRST) =>
  commitAs(
    db.pool("app"),
    U.admin,
    ...call("credential_put", [
      ws,
      channel,
      expected,
      ...sealed(),
      in1h(),
      null,
      "digest-put",
      snapshot.manifest,
      snapshot.api,
      null,
      JSON.stringify(snapshot.capabilities),
      JSON.stringify(snapshot.limits),
      "req-p",
      null,
    ]),
  );

describe("channel_connect", () => {
  it("a first connect creates the channel and asks for generation 1; the same identity reuses the row", async () => {
    const account = randomUUID();
    const [first] = await connect(WA, account);
    expect(first).toMatchObject({ next_generation: 1 });
    await put(WA, first?.channel_id as string, 0);
    const [again] = await connect(WA, account);
    expect(again).toEqual({ channel_id: first?.channel_id, next_generation: 2 });
    expect(
      (await rows("SELECT count(*)::int AS n FROM app.channels WHERE provider_account_id = $1", [account]))[0]
        ?.n,
    ).toBe(1);
  });

  it("a reconnect that resolves to a different account is refused with the generic SH409 and changes nothing", async () => {
    const [target] = await connect(WA, randomUUID());
    const refused = await attempt(
      db.pool("app"),
      AS_ADMIN,
      ...call("channel_connect", [
        WA,
        "fixture_oauth",
        "profile",
        "other-account",
        null,
        "Account",
        null,
        null,
        target?.channel_id,
        "req-c",
        null,
      ]),
    );
    expect(refused.error).toMatchObject({ code: "SH409" });
    expect(String((refused.error as Error).message)).not.toContain("other-account");
    expect(
      (
        await rows("SELECT count(*)::int AS n FROM app.channels WHERE provider_account_id = 'other-account'")
      )[0]?.n,
    ).toBe(0);
  });

  it("the same account connects in two workspaces, and neither answer mentions the other", async () => {
    const account = randomUUID();
    const [a] = await connect(WA, account);
    const [b] = await connect(WB, account, null, U.bOwner);
    expect(a?.channel_id).not.toBe(b?.channel_id);
    expect(b).toMatchObject({ next_generation: 1 });
  });
});

describe("credential_put", () => {
  it("credential_put refuses a generation that is not the next, writes the first snapshot, and writes none for an unchanged one", async () => {
    const [made] = await connect(WA, randomUUID());
    const channel = made?.channel_id as string;
    await expect(put(WA, channel, 3)).rejects.toMatchObject({ code: "SH409" });
    await put(WA, channel, 0);
    expect((await credentialOf(channel))?.generation).toBe(1);
    expect(
      await rows("SELECT epoch FROM app.channel_capability_snapshots WHERE channel_id = $1", [channel]),
    ).toEqual([{ epoch: 1 }]);
    await put(WA, channel, 1);
    expect((await credentialOf(channel))?.generation).toBe(2);
    expect(
      await rows("SELECT epoch FROM app.channel_capability_snapshots WHERE channel_id = $1", [channel]),
    ).toEqual([{ epoch: 1 }]);
  });
});

describe("the workspace salt", () => {
  const ensure = (ws: string, salt: Buffer) =>
    commitAs(db.pool("app"), U.admin, "SELECT app.workspace_salt_ensure($1, $2) AS salt", [ws, salt]);

  it("two first-credential callers end with one salt, and the loser receives the winner's", async () => {
    const [a, b] = [randomBytes(32), randomBytes(32)];
    const [first, second] = await Promise.all([ensure(WA, a), ensure(WA, b)]);
    expect(first[0]?.salt).toEqual(second[0]?.salt);
    expect([a, b].some((salt) => salt.equals(first[0]?.salt as Buffer))).toBe(true);
    expect(
      (await rows("SELECT count(*)::int AS n FROM app.workspace_key_salts WHERE workspace_id = $1", [WA]))[0]
        ?.n,
    ).toBe(1);
  });

  it("refuses a salt that is not 32 bytes", async () => {
    await expect(
      commitAs(db.pool("app"), U.bOwner, "SELECT app.workspace_salt_ensure($1, $2)", [WB, randomBytes(31)]),
    ).rejects.toMatchObject({ code: "22023" });
  });
});

describe("crypto-shred", () => {
  // The salt row is the shred. With it gone nothing opens; a new salt cannot open the old row.
  it("crypto-shred: with the salt row deleted the credential cannot be opened, now or under a new salt", async () => {
    const keys = new EnvKeyProvider({
      SHOUTORY_ACTIVE_KEY_ID: "k1",
      SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
    });
    const channel = await plantChannel(WB);
    const aad = {
      formatVersion: 1,
      scopeId: WB,
      ownerId: channel,
      credentialKind: "channel_token" as const,
      generation: 1,
    };
    const salt = randomBytes(32);
    await commitAs(db.pool("app"), U.bOwner, "SELECT app.workspace_salt_ensure($1, $2)", [WB, salt]);
    const stored = seal("token-for-shred", aad, keys, salt);
    await rows(
      `INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv, ciphertext,
         auth_tag, wrap_iv, wrap_tag, wrapped_dek, access_expires_at, refresh_token_digest, state)
       VALUES ($1, $2, 1, 'channel_token', 1, $3, $4, $5, $6, $7, $8, $9, now() + interval '1 hour', 'd', 'active')`,
      [
        WB,
        channel,
        stored.keyId,
        stored.iv,
        stored.ciphertext,
        stored.tag,
        stored.wrapIv,
        stored.wrapTag,
        stored.wrappedDek,
      ],
    );
    const opened = await commitAs(db.pool("app"), U.bOwner, ...call("credential_open", [WB, channel]));
    expect(open(stored, aad, keys, opened[0]?.salt as Buffer).expose()).toBe("token-for-shred");
    await rows("DELETE FROM app.workspace_key_salts WHERE workspace_id = $1", [WB]);
    expect(await commitAs(db.pool("app"), U.bOwner, ...call("credential_open", [WB, channel]))).toEqual([]);
    await commitAs(db.pool("app"), U.bOwner, "SELECT app.workspace_salt_ensure($1, $2)", [
      WB,
      randomBytes(32),
    ]);
    const later = await commitAs(db.pool("app"), U.bOwner, ...call("credential_open", [WB, channel]));
    expect(() => open(stored, aad, keys, later[0]?.salt as Buffer)).toThrow(EnvelopeError);
  });
});

const begin = (ws: string, channel: string, owner: string, seconds = 60) =>
  run(job([ws]), call("credential_refresh_begin", [ws, channel, owner, seconds]), "worker");
// The fencing number is the one begin answered; 0 for a credential no lease was ever taken on.
const commit = (channel: string, digest: string, generation: number, next: string, fencing = 0) =>
  run(
    job([WA]),
    call("credential_refresh_commit", [
      WA,
      channel,
      digest,
      generation,
      fencing,
      ...sealed(),
      in1h(),
      null,
      next,
    ]),
    "worker",
  );
const fresh = async (planted: Planted = {}) => {
  const channel = await plantChannel(WA);
  await plantCredential(WA, channel, planted);
  return channel;
};

describe("the refresh lease", () => {
  it.each([
    [4, false],
    [5, true],
    [300, true],
    [301, false],
  ])("a lease of %i seconds is accepted: %s", async (seconds, accepted) => {
    const channel = await fresh();
    const outcome = await attempt(
      db.pool("app"),
      AS_ADMIN,
      ...call("credential_refresh_begin", [WA, channel, "w", seconds]),
    );
    if (accepted) expect(outcome.error).toBeUndefined();
    else expect(outcome.error).toMatchObject({ code: "22023" });
  });

  it("two refreshers: one wins the lease, the loser sees the generation before the commit and the new one after it", async () => {
    const channel = await fresh();
    const [first] = await begin(WA, channel, "a");
    const [second] = await begin(WA, channel, "b");
    expect([first?.won, second?.won]).toEqual([true, false]);
    expect(second).toMatchObject({ generation: 1, refresh_token_digest: "digest-1" });
    expect((await commit(channel, "digest-1", 1, "digest-2", first?.fencing as number))[0]).toMatchObject({
      landed: true,
      generation: 2,
    });
    const [after] = await begin(WA, channel, "b");
    expect(after).toMatchObject({ won: true, generation: 2, refresh_token_digest: "digest-2" });
  });
});

describe("the compare-and-set", () => {
  it("a result whose digest moved is discarded and the row is untouched", async () => {
    const channel = await fresh();
    expect((await commit(channel, "digest-0", 1, "digest-x"))[0]).toMatchObject({ landed: false });
    expect(await credentialOf(channel)).toMatchObject({ refresh_token_digest: "digest-1", generation: 1 });
  });

  it("a result from the unchanged digest lands after its lease expired, and clears the lease and records ok", async () => {
    const channel = await fresh();
    const [lease] = await begin(WA, channel, "a");
    await expireLease(channel);
    expect((await commit(channel, "digest-1", 1, "digest-2", lease?.fencing as number))[0]).toMatchObject({
      landed: true,
    });
    expect(await credentialOf(channel)).toMatchObject({
      refresh_token_digest: "digest-2",
      generation: 2,
      refreshing_until: null,
      refresh_attempt_outcome: "ok",
    });
    expect((await channelOf(channel))?.token_expires_at).not.toBeNull();
  });

  // The token lands on its digest and generation alone, but only the holder of the current lease may clear it
  // and write the marker; a stale refresher leaves a newer lease and its marker alone.
  it("a commit that lands with a stale fencing number leaves the newer lease and its marker", async () => {
    const channel = await fresh();
    const [stale] = await begin(WA, channel, "a");
    await expireLease(channel);
    await begin(WA, channel, "b");
    expect((await commit(channel, "digest-1", 1, "digest-2", stale?.fencing as number))[0]).toMatchObject({
      landed: true,
      generation: 2,
    });
    expect(await credentialOf(channel)).toMatchObject({
      refresh_owner: "b",
      refresh_attempt_outcome: "unknown",
    });
    expect((await credentialOf(channel))?.refreshing_until).not.toBeNull();
  });

  it("an answer with no new refresh token (the digest stays) lands once: a second commit of the same generation is refused", async () => {
    const channel = await fresh();
    expect((await commit(channel, "digest-1", 1, "digest-1"))[0]).toMatchObject({
      landed: true,
      generation: 2,
    });
    expect((await commit(channel, "digest-1", 1, "digest-1"))[0]).toMatchObject({ landed: false });
    expect((await credentialOf(channel))?.generation).toBe(2);
  });
});

describe("credential_refresh_fail", () => {
  const fail = (channel: string, digest: string, outcome: string, reason: string | null, fencing = 0) =>
    run(
      job([WA]),
      call("credential_refresh_fail", [WA, channel, digest, fencing, outcome, reason]),
      "worker",
    ).then((r) => r[0]?.credential_refresh_fail);
  const channelIn = async (state: string) => {
    const channel = await plantChannel(WA, state);
    await plantCredential(WA, channel);
    return channel;
  };

  it("a confirmed revocation on the unchanged digest moves a connected channel to needs_reconnect with its reason", async () => {
    const channel = await channelIn("connected");
    expect(await fail(channel, "digest-1", "failed", "revoked_confirmed")).toBe("applied");
    expect(await channelOf(channel)).toMatchObject({
      connection_state: "needs_reconnect",
      state_reason: "revoked_confirmed",
    });
    expect((await credentialOf(channel))?.refresh_attempt_outcome).toBe("failed");
  });

  it("a digest that moved is a no-op answering changed: state and marker stay", async () => {
    const channel = await channelIn("connected");
    expect(await fail(channel, "digest-0", "failed", "revoked_confirmed")).toBe("changed");
    expect(await channelOf(channel)).toMatchObject({ connection_state: "connected", state_reason: null });
  });

  it("a stale fail after a newer lease answers changed and leaves the newer lease and marker", async () => {
    const channel = await channelIn("connected");
    const begun = (owner: string) =>
      run(job([WA]), call("credential_refresh_begin", [WA, channel, owner, 60]), "worker");
    const [stale] = await begun("a");
    await expireLease(channel);
    await begun("b");
    expect(await fail(channel, "digest-1", "failed", "revoked_confirmed", stale?.fencing as number)).toBe(
      "changed",
    );
    expect(await channelOf(channel)).toMatchObject({ connection_state: "connected" });
    expect(await credentialOf(channel)).toMatchObject({
      refresh_owner: "b",
      refresh_attempt_outcome: "unknown",
    });
  });

  it.each(["disabled", "disconnected"])("a failure on a %s channel keeps that state", async (state) => {
    const channel = await channelIn(state);
    await fail(channel, "digest-1", "failed", "refresh_token_rotated_unknown");
    expect((await channelOf(channel))?.connection_state).toBe(state);
  });
});

describe("channel_enable restores connected only with a usable credential", () => {
  const CASES: [string, Planted | null, string][] = [
    ["an active credential with no refresh expiry", {}, "connected"],
    ["an active credential whose refresh expiry is ahead", { refreshExpiresIn: "1 day" }, "connected"],
    ["no credential row", null, "needs_reconnect"],
    ["a read_only credential", { state: "read_only" }, "needs_reconnect"],
    [
      "an active credential whose refresh expiry has passed",
      { refreshExpiresIn: "-1 day" },
      "needs_reconnect",
    ],
  ];
  it.each(CASES)("%s gives %s", async (_name, credential, state) => {
    const channel = await plantChannel(WA, "disabled");
    if (credential) await plantCredential(WA, channel, credential);
    await commitAs(db.pool("app"), U.admin, "SELECT app.channel_enable($1, $2, 'req-e', NULL)", [
      WA,
      channel,
    ]);
    const after = await channelOf(channel);
    expect(after?.connection_state).toBe(state);
    expect(after?.state_reason).toBeNull();
    if (state === "connected") expect(after?.reconnect_deadline).toBeNull();
  });
});

describe("channel_enable restores the state the channel had before it was disabled", () => {
  it.each([
    ["connected", "connected"],
    ["needs_reconnect", "needs_reconnect"],
  ])("a channel disabled from %s returns %s, with a usable credential", async (from, state) => {
    const channel = await plantChannel(WA, from);
    await plantCredential(WA, channel);
    for (const definer of ["channel_disable", "channel_enable"]) {
      await commitAs(db.pool("app"), U.admin, `SELECT app.${definer}($1, $2, 'req-d', NULL)`, [WA, channel]);
    }
    expect((await channelOf(channel))?.connection_state).toBe(state);
  });
});

describe("channels_expire_tokens", () => {
  const expire = () => run(SWEEP, call("channels_expire_tokens", [500]), "worker");

  it.each([
    [
      "a passed token with no refresh token",
      { accessExpiresIn: "-1 minute", digest: null },
      "needs_reconnect",
    ],
    ["a passed token with a refresh token", { accessExpiresIn: "-1 minute" }, "connected"],
    ["a token ahead with no refresh token", { accessExpiresIn: "1 hour", digest: null }, "connected"],
    ["a token with no expiry and no refresh token", { accessExpiresIn: null, digest: null }, "connected"],
  ] as const)("%s leaves the channel %s", async (_name, planted, state) => {
    const channel = await plantChannel(WA);
    await plantCredential(WA, channel, planted);
    await expire();
    const after = await channelOf(channel);
    expect(after?.connection_state).toBe(state);
    if (state === "needs_reconnect") {
      expect(after?.state_reason).toBe("token_expired");
      expect(after?.reconnect_deadline).not.toBeNull();
    }
  });

  it.each([
    ["the expiry", () => attempt(db.pool("worker"), job([WA]), ...call("channels_expire_tokens", [10]))],
    [
      "the expiry as a user",
      () => attempt(db.pool("app"), asUser(U.admin), ...call("channels_expire_tokens", [10])),
    ],
  ])("refuses %s outside the sweep purpose", async (_name, go) => {
    expect((await go()).error).toMatchObject({ code: "42501" });
  });
});

describe("channel_revoke_confirmed", () => {
  it("moves a connected channel to needs_reconnect and audits it; another workspace's job cannot", async () => {
    const channel = await plantChannel(WA);
    await plantCredential(WA, channel, { digest: null });
    const foreign = await attempt(
      db.pool("worker"),
      job([WB]),
      ...call("channel_revoke_confirmed", [WA, channel]),
    );
    expect(foreign.error).toMatchObject({ code: "42501" });
    await run(job([WA]), call("channel_revoke_confirmed", [WA, channel]), "worker");
    expect(await channelOf(channel)).toMatchObject({
      connection_state: "needs_reconnect",
      state_reason: "revoked_confirmed",
    });
    expect((await channelOf(channel))?.reconnect_deadline).not.toBeNull();
    const audited = await rows("SELECT action FROM app.audit_logs WHERE resource_id = $1", [channel]);
    expect(audited.map((r) => r.action)).toContain("channel.reconnect_needed");
  });
});

describe("channel_health_record", () => {
  it("writes no health on a channel that is not connected", async () => {
    const channel = await plantChannel(WA, "disabled");
    await run(
      job([WA]),
      call("channel_health_record", [WA, channel, "ok", "digest-h", "v1", null, "{}", "{}"]),
      "worker",
    );
    expect((await channelOf(channel))?.health).toBeNull();
  });

  const record = (channel: string, n: number) =>
    run(
      job([WA]),
      call("channel_health_record", [
        WA,
        channel,
        "ok",
        `digest-${n}`,
        "v1",
        null,
        JSON.stringify({ text: true }),
        JSON.stringify({ text: 280 }),
      ]),
      "worker",
    ).then((r) => r[0]?.channel_health_record);

  it("stores health with its check time, snapshots only on change, and keeps the last 5", async () => {
    const channel = await plantChannel(WA);
    expect(await record(channel, 1)).toBe(true);
    expect(await record(channel, 1)).toBe(false);
    expect(await channelOf(channel)).toMatchObject({ health: "ok", capability_epoch: 1 });
    expect((await channelOf(channel))?.health_checked_at).not.toBeNull();
    for (const n of [2, 3, 4, 5, 6, 7]) await record(channel, n);
    const epochs = await rows(
      "SELECT epoch FROM app.channel_capability_snapshots WHERE channel_id = $1 ORDER BY epoch",
      [channel],
    );
    expect(epochs.map((r) => r.epoch)).toEqual([3, 4, 5, 6, 7]);
  });
});

describe("sealed_key_ids", () => {
  it("lists the key ids of credential rows", async () => {
    const channel = await plantChannel(WA);
    await plantCredential(WA, channel, { keyId: "cred-key-7" });
    const listed = await db.pool("app").query("SELECT key_id FROM app.sealed_key_ids()");
    expect(listed.rows.map((r) => r.key_id)).toContain("cred-key-7");
  });
});

const due = (lim = 100, ctx: TenantCtx = SWEEP, pool: "app" | "worker" = "worker", margin = 300) =>
  attempt(db.pool(pool), ctx, ...call("due_token_refreshes", [lim, margin]));

describe("due_token_refreshes", () => {
  it("returns only connected channels whose active token is due and unleased, with workspace and channel ids", async () => {
    const dueChannel = await plantChannel(WA);
    await plantCredential(WA, dueChannel, { accessExpiresIn: "1 minute" });
    const others = [
      [await plantChannel(WA), { accessExpiresIn: "2 hours" }],
      [await plantChannel(WA, "disabled"), { accessExpiresIn: "-1 minute" }],
      [await plantChannel(WA), { accessExpiresIn: "-1 minute", state: "read_only" }],
      // A credential with no refresh token (a NULL digest) never reaches the provider, so the sweep never lists it.
      [await plantChannel(WA), { accessExpiresIn: "-1 minute", digest: null }],
      // A token with no expiry lives until the provider says otherwise, so it is never due.
      [await plantChannel(WA), { accessExpiresIn: null }],
    ] as const;
    for (const [channel, planted] of others) await plantCredential(WA, channel, planted);
    const leased = await plantChannel(WA);
    await plantCredential(WA, leased, { accessExpiresIn: "-1 minute" });
    await run(job([WA]), call("credential_refresh_begin", [WA, leased, "w", 60]), "worker");
    const result = await due();
    const mine = (result.rows ?? []).filter((r) =>
      [dueChannel, leased, ...others.map(([c]) => c)].includes(r.channel_id as string),
    );
    expect(mine).toEqual([{ workspace_id: WA, channel_id: dueChannel }]);
  });
});

describe("due_token_refreshes across workspaces", () => {
  it("lists due channels of every workspace, and a call starts with those the last calls listed least recently", async () => {
    await rows("UPDATE app.channel_credentials SET refresh_swept_at = now()");
    const failing: string[] = [];
    for (const workspace of [WA, WB]) {
      const channel = await plantChannel(workspace);
      await plantCredential(workspace, channel, { accessExpiresIn: "-2 days" });
      failing.push(channel);
    }
    await rows(
      `INSERT INTO app.channels (id, workspace_id, provider_id, account_kind, provider_account_id, display_name,
         connection_state)
       SELECT g, $1, 'fixture_oauth', 'profile', g::text, 'sweep channel', 'connected'
         FROM (SELECT uuidv7() AS g FROM generate_series(1, 499)) AS s`,
      [WA],
    );
    await rows(
      `INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv,
         ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, access_expires_at, refresh_token_digest)
       SELECT c.workspace_id, c.id, 1, 'channel_token', k.format_version, k.key_id, k.iv, k.ciphertext, k.auth_tag,
           k.wrap_iv, k.wrap_tag, k.wrapped_dek, now() - interval '1 day', 'digest-1'
         FROM app.channels AS c CROSS JOIN app.channel_credentials AS k
         WHERE c.display_name = 'sweep channel' AND k.channel_id = $1`,
      [failing[0]],
    );
    const healthy = await plantChannel(WA);
    await plantCredential(WA, healthy, { accessExpiresIn: "1 minute" });
    const first = await run(SWEEP, call("due_token_refreshes", [500, 300]), "worker");
    expect(first).toHaveLength(500);
    expect(first.map((r) => r.channel_id)).toEqual(expect.arrayContaining(failing));
    expect(first.map((r) => r.channel_id)).not.toContain(healthy);
    const second = await run(SWEEP, call("due_token_refreshes", [500, 300]), "worker");
    expect(second.map((r) => r.channel_id)).toContain(healthy);
  });
});

describe("due_token_refreshes refusals", () => {
  it.each([
    ["a job principal of the workspace with no sweep purpose", () => due(10, job([WA]))],
    [
      "a job principal with another system purpose",
      () => due(10, { principalKind: "job", jobPurpose: "ledger" }),
    ],
    ["the app role", () => due(10, asUser(U.admin), "app")],
    ["a user principal through the worker role", () => due(10, asUser(U.admin), "worker")],
    [
      "a service principal",
      () => due(10, { principalKind: "service", serviceKind: "api_key", principalId: randomUUID() }),
    ],
    ["a limit of 0", () => due(0)],
    ["a limit of 501", () => due(501)],
    ["a margin of 59 seconds", () => due(10, undefined, "worker", 59)],
    ["a margin of 3601 seconds", () => due(10, undefined, "worker", 3601)],
  ])("refuses %s", async (_who, go) => {
    expect((await go()).error).toMatchObject({ code: expect.stringMatching(/^(42501|22023)$/) });
  });
});
