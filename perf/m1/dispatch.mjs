// Measurement script only (NFR-PERF-11; run alone after a build): how long a due post waits for its send, and what a batch of due targets costs the database (the 64-subtransaction cache of
// PostgreSQL 18, `PGPROC_MAX_CACHED_SUBXIDS`). It runs the real worker and the real SQL against the fixture provider
// and its simulator, on the database named by the same variables as the integration tests (a running PostgreSQL, see
// the README). Build first (`pnpm build`), then from the repository root, with nothing else running:
//
//   node perf/m1/dispatch.mjs [targets for the delay run, default 200] [seconds they are spread over, default 120]
//
// The delay of a post is `operation_attempts.effect_started_at - operations.due_at` of its committing attempt: the
// claim, the re-read and the prepare step are all in it, so it overstates the claim delay (there is no `claimed_at`).
import { randomBytes } from "node:crypto";

const root = new URL("../../", import.meta.url);
const load = (path) => import(new URL(path, root).href);
const { readTestEnv, createTemplate, cloneTemplate, withAdminClient, withDatabase, dropDatabase } =
  await load("packages/db/dist/testing/template.js");
const { withSystem } = await load("packages/db/dist/context/with-system.js");
const { startFixtureSimulator } = await load("packages/testkit/dist/fixture-provider/simulator.js");
const { createFixtureAdapter } = await load("packages/testkit/dist/fixture-provider/adapter.js");
const { fixtureManifest } = await load("packages/testkit/dist/fixture-provider/manifest.js");
const { createRegistry } = await load("packages/provider-sdk/dist/registry.js");
const { providersArgument } = await load("packages/core/dist/ledger/client.js");
const { EnvKeyProvider } = await load("packages/core/dist/crypto/keys.js");
const { SealedSecret } = await load("packages/core/dist/crypto/envelope.js");
const { startWorker } = await load("apps/api/dist/jobs/worker.js");
const { createLogger } = await load("apps/api/dist/logging/logger.js");

// An argument is a whole number above zero or the script refuses to run (a typo must not become NaN targets).
const wholeArgument = (index, fallback, name) => {
  const value = process.argv[index];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`${name} must be a whole number above zero: "${value}"`);
  return number;
};
const DELAY_TARGETS = wholeArgument(2, 200, "the number of targets");
const SPREAD_SECONDS = wholeArgument(3, 120, "the spread in seconds");
const SUBXID_SIZES = [32, 64, 65, 500];
const env = readTestEnv();
const { installJobs } = await load("apps/api/dist/jobs/install.js");
const template = await createTemplate(env);
await installJobs(withDatabase(env.roleUrls.owner, template), ["publish.perf", "reconcile.perf"]);
const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
const log = (line) => process.stderr.write(`${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const manifest = {
  ...fixtureManifest,
  id: "perf",
  rateLimits: [{ name: "posts", scope: "account", key: "account", max: 10_000, windowSeconds: 86_400 }],
};
const percentile = (values, share) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? 0;
};
const round = (value) => Math.round(value * 10) / 10;

// A workspace, one connected channel, and `count` scheduled targets due between now and `spread` seconds from now.
async function seed(db, count, spread) {
  return withAdminClient(env, db.name, async (client) => {
    const [user, org, workspace] = (
      await client.query("SELECT gen_random_uuid() a, gen_random_uuid() b, gen_random_uuid() c")
    ).rows.flatMap((r) => [r.a, r.b, r.c]);
    await client.query(
      'INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
      [user, "perf", `${user}@example.test`],
    );
    await client.query(
      "INSERT INTO app.organizations (id, name, slug, type) VALUES ($1, 'perf', $2, 'team')",
      [org, `perf-${org}`],
    );
    await client.query(
      "INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES ($1, $2, 'owner')",
      [org, user],
    );
    await client.query(
      "INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, 'perf', $3)",
      [workspace, org, `perf-${workspace}`],
    );
    await client.query(
      `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
       VALUES ($1, $2, (SELECT r.id FROM app.roles r WHERE r.workspace_id IS NULL AND r.key = 'owner'))`,
      [workspace, user],
    );
    const channel = (
      await client.query(
        `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
         VALUES ($1, 'perf', 'profile', 'perf-account', 'perf-account', 'connected') RETURNING id`,
        [workspace],
      )
    ).rows[0].id;
    const snapshot = {
      version: 1,
      draft: {
        variants: [
          {
            channel_id: channel,
            locale: null,
            post_type: "text",
            text: "perf",
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
    };
    await client.query(
      `WITH p AS (INSERT INTO app.posts (workspace_id, author_kind, author_id, status)
                  SELECT $1, 'user', $2, 'scheduled' FROM generate_series(1, $3) RETURNING id),
            v AS (INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
                  SELECT $1, p.id, 1, 'scheduled', $4::jsonb, decode(repeat('ab', 32), 'hex'), $2 FROM p RETURNING id, post_id)
       INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, due_at, frozen_version_id)
       SELECT $1, v.post_id, $5, 'scheduled', now() + random() * $6 * interval '1 second', v.id FROM v`,
      [workspace, user, count, JSON.stringify(snapshot), channel, spread],
    );
  });
}

// Waits until every target is published or the time allowed ends, and logs what state the operations are in.
async function untilPublished(db) {
  const count = (sql) => withAdminClient(env, db.name, async (c) => (await c.query(sql)).rows);
  const deadline = Date.now() + (SPREAD_SECONDS + 300) * 1000;
  const published = async () =>
    (await count("SELECT count(*)::int n FROM app.operations WHERE state = 'published'"))[0].n;
  while (Date.now() < deadline && (await published()) < DELAY_TARGETS) await sleep(2_000);
  log(
    `states at the end: ${JSON.stringify(await count("SELECT state, count(*)::int n FROM app.operations GROUP BY state"))}`,
  );
}

// The p50, p95 and p99 of the wait of a due post for its send, at one tick interval.
async function delayRun(tickMs) {
  const db = await cloneTemplate(env, template);
  const sim = await startFixtureSimulator();
  const keys = new EnvKeyProvider({
    SHOUTORY_ACTIVE_KEY_ID: "k1",
    SHOUTORY_KEK_K1: randomBytes(32).toString("base64"),
  });
  await seed(db, DELAY_TARGETS, SPREAD_SECONDS);
  const worker = await startWorker({
    connectionString: db.url("worker"),
    pool: db.pool("worker"),
    logger,
    role: "worker",
    mail: {
      keys,
      pepper: new SealedSecret("perf-pepper-0123456789abcdef0123456789"),
      smtpUrl: new SealedSecret("smtp://127.0.0.1:9"),
      from: "perf@example.test",
    },
    registry: createRegistry([manifest]),
    adapters: { perf: createFixtureAdapter({ baseUrl: sim.url }) },
    fetchFor: () => fetch,
    ledgerIntervalMs: tickMs,
  });
  await untilPublished(db);
  const delays = await withAdminClient(env, db.name, async (c) =>
    (
      await c.query(
        `SELECT extract(epoch FROM a.effect_started_at - o.due_at)::float8 AS s FROM app.operations o
         JOIN app.operation_attempts a ON a.operation_id = o.id AND a.step = 'commit'`,
      )
    ).rows.map((r) => r.s),
  );
  await worker.close();
  await sim.close();
  await db.drop();
  return {
    tick: `${tickMs / 1000} s`,
    sent: delays.length,
    p50: round(percentile(delays, 0.5)),
    p95: round(percentile(delays, 0.95)),
    p99: round(percentile(delays, 0.99)),
  };
}

// Admission, the claims and the sweeps over `count` targets all due now, with a second session counting subtransaction waits.
async function subxidRun(count) {
  const db = await cloneTemplate(env, template);
  await seed(db, count, 0);
  const pool = db.pool("worker");
  const providers = JSON.stringify(providersArgument([manifest]));
  let waits = 0;
  let sampling = true;
  // One client for the whole run, counting the waits of this database only.
  const sampler = withAdminClient(env, db.name, async (c) => {
    while (sampling) {
      waits += (
        await c.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'SubtransSLRU'",
        )
      ).rows[0].n;
      await sleep(10);
    }
  });
  const timed = async (run) => {
    const started = performance.now();
    await run();
    return performance.now() - started;
  };
  const admit = await timed(() =>
    withSystem(pool, "ledger", (tx) =>
      tx.query("SELECT * FROM app.admit_due_targets(500, $1::jsonb)", [providers]),
    ),
  );
  const claims = [];
  for (let n = 0; n < count; n++) {
    claims.push(
      await timed(() =>
        withSystem(pool, "ledger", (tx) =>
          tx.query("SELECT * FROM app.claim_operations('publish.perf', 1, 'perf')"),
        ),
      ),
    );
  }
  const sweep = await timed(async () => {
    await withSystem(pool, "ledger", (tx) => tx.query("SELECT app.sweep_expired_leases('{}'::jsonb)"));
    await withSystem(pool, "ledger", (tx) => tx.query("SELECT app.sweep_due_moves('{}'::jsonb)"));
  });
  sampling = false;
  await sampler;
  await db.drop();
  return {
    targets: count,
    admit_ms: round(admit),
    claim_p95_ms: round(percentile(claims, 0.95)),
    sweep_ms: round(sweep),
    subtrans_waits: waits,
  };
}

const table = [];
try {
  log("delay run at the 30 s tick");
  const thirty = await delayRun(30_000);
  table.push(thirty);
  if (thirty.p95 > 60) {
    log("p95 is over 60 s: delay run at the 15 s tick");
    table.push(await delayRun(15_000));
  }
  console.log("claim delay (s), effect_started_at - due_at:");
  console.table(table);
  const subxid = [];
  for (const size of SUBXID_SIZES) {
    log(`subtransaction run at ${size} targets`);
    subxid.push(await subxidRun(size));
  }
  console.log("batch of due targets:");
  console.table(subxid);
} finally {
  await dropDatabase(env, template);
}
