import { randomUUID } from "node:crypto";
import { withSystem } from "@shoutory/db/context/system";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import type { ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { startFixtureSimulator } from "@shoutory/testkit/fixture-provider/simulator";
import { afterAll, beforeAll, inject } from "vitest";
import { createBoss } from "../../src/jobs/boss.js";
import { createLedgerTick } from "../../src/jobs/ledger/tick.js";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { createLogger } from "../../src/logging/logger.js";
import { connectChannel, ledgerCredentials } from "./ledger-credentials.js";
import { seedWorkspace } from "./ledger-seed.js";

const env = readTestEnv();
const boss = () => createBoss(state.db.url("worker"), () => undefined);
const state = {} as { db: TestDatabase; ws: string; queue: ReturnType<typeof boss> };

export function useDispatchEnv(): void {
  beforeAll(async () => {
    state.db = await cloneTemplate(env, inject("shoutoryTemplate"));
    state.ws = await admin((client) => seedWorkspace(client));
    state.queue = boss();
    await state.queue.start();
  });
  afterAll(async () => {
    await state.queue.stop({ graceful: true });
    await state.db.drop();
  });
}

export const queueOf = () => state.queue;

export const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
export const workerPool = () => state.db.pool("worker");
export const admin = <T>(run: Parameters<typeof withAdminClient<T>>[2]) =>
  withAdminClient(env, state.db.name, run);
export const READ_BACK_ONLY = {
  idempotency: { ...fixtureManifest.idempotency, resendAfterUnknown: "read_back_only" },
};
export const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
export const ledger = (sql: string, params: unknown[] = []) =>
  withSystem(workerPool(), "ledger", (tx) => tx.query(sql, params));
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Holds the first matching call until it is aborted (lease lost or timeout) or released, then sends it to the simulator.
export function holdFirst(match: (url: string, method: string) => boolean) {
  let armed = true;
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  const hit = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: typeof fetch = async (input, init) => {
    if (!armed || !match(String(input), init?.method ?? "GET")) return fetch(input, init);
    armed = false;
    reached();
    await new Promise<void>((resolve, reject) => {
      void released.then(resolve);
      const stop = () => reject(new DOMException("the call was aborted", "AbortError"));
      if (init?.signal?.aborted) stop();
      else init?.signal?.addEventListener("abort", stop, { once: true });
    });
    return fetch(input, init);
  };
  return { fetch: held, hit, release };
}
type Hold = ReturnType<typeof holdFirst>;
// Waits until the held call is made; a dispatch that never makes it fails the row at once instead of at its timeout.
export const called = (hold: Hold) =>
  Promise.race([
    hold.hit,
    sleep(15_000).then(() => {
      throw new Error("the held call was never made");
    }),
  ]);
export const isCommit = (url: string, method: string) => method === "POST" && url.endsWith("/v1/posts");
export const isPrepare = (url: string, method: string) => method === "POST" && url.endsWith("/v1/validate");

interface Options {
  /** The lease of the manifest and of the operation in seconds; the call timeout is what is left of it after 10 s. */
  lease?: number;
  manifest?: Record<string, unknown>;
  hold?: Hold;
  before?: (route: string) => void | Promise<void>;
  clock?: () => Date;
}
// The tick and the read-back pass, in the order the worker's two loops would reach them.
async function bothPasses(loop: ReturnType<typeof createLedgerTick>): Promise<void> {
  await loop.tick();
  await loop.reconcile();
}
export async function makeEnv(o: Options = {}) {
  const lease = o.lease ?? 12;
  const commits = { count: 0 };
  const sim = await startFixtureSimulator({
    before: async (route: string) => {
      if (route === "POST /v1/posts") commits.count += 1;
      await o.before?.(route);
    },
  });
  // A provider id of its own, so a row another test left behind is never claimed by this test's tick.
  const providerId = `fx_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const manifestWith = (extra: Record<string, unknown> = {}) => ({
    ...fixtureManifest,
    id: providerId,
    leaseSeconds: { prepare: lease, commit: lease, readBack: lease, edit: lease, delete: lease },
    ...o.manifest,
    ...extra,
  });
  const registry = createRegistry([manifestWith()]);
  const adapters: Record<string, ProviderAdapter> = {
    [providerId]: createFixtureAdapter({ baseUrl: sim.url }),
  };
  const fetchFor = () => o.hold?.fetch ?? fetch;
  const queueName = `publish.${providerId}`;
  const common = {
    pool: workerPool(),
    logger,
    registry,
    adapters,
    fetchFor,
    credentials: ledgerCredentials(workerPool(), { registry, adapters, fetchFor }),
    ...(o.clock === undefined ? {} : { clock: o.clock }),
  };
  const tickOf = (over: object = {}) =>
    bothPasses(createLedgerTick({ ...common, boss: state.queue, ...over }));
  return {
    tickWith: (extra: Record<string, unknown>, at?: Date) =>
      tickOf({
        registry: createRegistry([manifestWith(extra)]),
        ...(at === undefined ? {} : { clock: () => at }),
      }),
    sim,
    commits,
    registry,
    adapters,
    fetchFor,
    credentials: common.credentials,
    lease,
    providerId,
    queueName,
    reconcileQueue: `reconcile.${providerId}`,
    sweepNow: { [providerId]: { first_backoff_seconds: 0, unverified_horizon_days: 30 } },
    turn: () =>
      runTurn({ ...common, queue: queueName, owner: "owner-w", closing: new AbortController().signal }),
    tick: () => tickOf(),
    close: () => sim.close(),
  };
}
export type Env = Awaited<ReturnType<typeof makeEnv>>;

const SNAPSHOT = (channel: string) => ({
  version: 1,
  draft: {
    variants: [
      {
        channel_id: channel,
        locale: null,
        post_type: "text",
        text: "hello dispatch",
        parts: [],
        settings: {},
        media: [],
      },
    ],
  },
  resolved: {
    variants: [{ channel_id: channel, locale: null, settings: {} }],
    media: {},
    manifestDigest: {},
  },
});
export interface Plant {
  state?: string;
  effect?: string;
  reconcile?: true;
  horizonEndedAgo?: number;
  /** No frozen version: nothing to send. */
  unfrozen?: true;
  /** A frozen version whose snapshot holds no variant for the channel. */
  unreadable?: true;
  /** Held by a worker that is gone: the lease ended a second ago. */
  leased?: true;
  attempts?: number;
  reason?: string;
  waitSeconds?: number;
  host?: string;
  token?: string;
  noCredential?: true;
}
const plantExtras = (o: Plant): Record<string, unknown> => ({
  ...(o.attempts === undefined ? {} : { attempt_count: o.attempts }),
  ...(o.reason === undefined ? {} : { reason_code: o.reason }),
  ...(o.waitSeconds === undefined ? {} : { next_attempt_at: new Date(Date.now() + o.waitSeconds * 1000) }),
  ...(o.leased
    ? { lease_owner: "dead", lease_expires_at: new Date(Date.now() - 1000), heartbeat_at: new Date() }
    : {}),
  ...(o.horizonEndedAgo === undefined
    ? {}
    : { unverified_until: new Date(Date.now() - o.horizonEndedAgo * 1000) }),
});
const plantVersion = async (o: Plant, post: string, channel: string): Promise<string> =>
  String(
    (
      await rows(
        `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
         VALUES ($1, $2, 1, 'scheduled', $3::jsonb, decode(repeat('ab', 32), 'hex'), $4) RETURNING id`,
        [state.ws, post, JSON.stringify(o.unreadable ? { version: 1 } : SNAPSHOT(channel)), randomUUID()],
      )
    )[0]?.id,
  );
async function plantChannel(providerId: string, o: Plant): Promise<{ id: string }> {
  const account = `dispatch-${randomUUID().slice(0, 8)}`;
  if (o.noCredential) {
    const [channel] = await rows(
      `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
       VALUES ($1, $3, 'profile', $2, $2, 'connected') RETURNING id`,
      [state.ws, account, providerId],
    );
    return { id: String(channel?.id) };
  }
  const id = await connectChannel(workerPool(), {
    workspace: state.ws,
    provider: providerId,
    account,
    ...(o.host === undefined ? {} : { host: o.host }),
    ...(o.token === undefined ? {} : { token: o.token }),
  });
  return { id };
}
export async function plant(
  e: Pick<Env, "providerId" | "queueName" | "reconcileQueue" | "lease">,
  o: Plant = {},
): Promise<string> {
  const { ws } = state;
  const channel = await plantChannel(e.providerId, o);
  const [post] = await rows(
    "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
    [ws, randomUUID()],
  );
  const version = await plantVersion(o, String(post?.id), String(channel?.id));
  const [variant] = await rows(
    "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, 'in_progress') RETURNING id",
    [ws, post?.id, channel?.id],
  );
  const given: Record<string, unknown> = {
    workspace_id: ws,
    variant_id: variant?.id,
    channel_id: channel?.id,
    provider_id: e.providerId,
    queue: o.reconcile ? e.reconcileQueue : e.queueName,
    kind: "publish",
    state: o.state ?? "pending",
    effect: o.effect ?? "none",
    last_actor: "S",
    due_at: new Date(Date.now() - 120_000),
    next_attempt_at: new Date(Date.now() - 60_000),
    next_check_at: new Date(Date.now() - 60_000),
    lateness_deadline: new Date(Date.now() + 7_200_000),
    idempotency_marker: `dispatch-${randomUUID()}`,
    frozen_version_id: o.unfrozen ? null : version,
    frozen_snapshot_hash: o.unfrozen ? null : Buffer.alloc(32, 0xab),
    requested_by: randomUUID(),
    lease_seconds: e.lease,
    fencing_token: 1,
    ...plantExtras(o),
  };
  const names = Object.keys(given);
  return admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const made = await client.query(
      `INSERT INTO app.operations (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(given),
    );
    await client.query("COMMIT");
    return made.rows[0].id as string;
  });
}
export const opOf = async (id: string) =>
  (
    await rows(
      `SELECT state, effect, queue, reason_code, fencing_token::int AS token, lease_owner, attempt_count,
         next_escalation_at IS NOT NULL AS escalated, unverified_until IS NOT NULL AS horizon,
         extract(epoch FROM unverified_until - clock_timestamp())::float8 AS horizon_in, heartbeat_at,
         (SELECT count(*)::int FROM app.operation_attempts a WHERE a.operation_id = o.id) AS attempts,
         (SELECT count(*)::int FROM app.operation_attempts a WHERE a.operation_id = o.id AND a.finished_at IS NULL) AS open,
         (SELECT count(*)::int FROM app.outbox x WHERE x.payload ->> 'operation_id' = o.id::text) AS events
       FROM app.operations o WHERE o.id = $1`,
      [id],
    )
  )[0] as Record<string, unknown>;
export const typesOf = async (id: string) =>
  (await rows("SELECT type FROM app.outbox WHERE payload ->> 'operation_id' = $1", [id])).map(
    (row) => row.type,
  );
export async function takeBack(id: string, providers: object = {}): Promise<void> {
  await rows(
    "UPDATE app.operations SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [id],
  );
  await ledger("SELECT app.sweep_expired_leases($1::jsonb)", [JSON.stringify(providers)]);
}

export async function recover(e: Env, id: string): Promise<void> {
  for (let round = 0; round < 8; round++) {
    const at = String((await opOf(id)).state);
    if (at === "published") return;
    if (at === "pending") await e.turn();
    else {
      await rows("UPDATE app.operations SET next_check_at = now(), next_attempt_at = now() WHERE id = $1", [
        id,
      ]);
      await e.tick();
    }
  }
}

// A committing attempt that began `ago` seconds back and recorded the id the provider gave (none when null).
export const marked = (id: string, excerpt: string | null = null, ago = 30) =>
  rows(
    `INSERT INTO app.operation_attempts (workspace_id, operation_id, attempt_no, step, fencing_token,
       effect_started_at, effect, response_excerpt)
     VALUES ($1, $2, 1, 'commit', 1, now() - make_interval(secs => $3::float8), 'possible', $4)`,
    [state.ws, id, ago, excerpt],
  );
