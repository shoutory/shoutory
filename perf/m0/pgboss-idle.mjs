// Measurement script only (V-31, run alone in the baseline run after a build, AGENTS 6.19): the idle cost of the job queue with
// many queues being polled. It installs the queue's schema into a scratch database, creates N queues, works each of
// them and counts the transactions the database commits while nothing is queued.
//
//   SHOUTORY_PERF_DATABASE_URL=postgres://owner:...@localhost:5432/scratch node perf/m0/pgboss-idle.mjs [queues] [poll s] [seconds]
//
// The database must be a scratch one with nothing else connected: the count is the whole database's.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const url = process.env.SHOUTORY_PERF_DATABASE_URL;
if (!url) throw new Error("SHOUTORY_PERF_DATABASE_URL is not set");
const [queues = 40, pollSeconds = 30, seconds = 120] = process.argv.slice(2).map(Number);

const fromApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const fromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { PgBoss } = await import(pathToFileURL(fromApi.resolve("pg-boss")).href);
const { Client } = fromDb("pg");

const boss = new PgBoss({
  connectionString: url,
  supervise: false,
  schedule: false,
  persistQueueStats: false,
});
boss.on("error", (error) => {
  throw error;
});
await boss.start();
const names = Array.from({ length: queues }, (_, i) => `idle_probe_${i}`);
for (const name of names) {
  await boss.createQueue(name, { retryLimit: 0 });
  await boss.work(name, { pollingIntervalSeconds: pollSeconds }, async () => undefined);
}
const probe = new Client({ connectionString: url });
await probe.connect();
const commits = async () =>
  Number(
    (await probe.query("SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()")).rows[0]
      .xact_commit,
  );
const before = await commits();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
// The first read's own commit falls inside the interval.
const used = (await commits()) - before - 1;
await probe.end();
await boss.stop({ graceful: false });
process.stdout.write(
  `${JSON.stringify({ queues, pollSeconds, seconds, commits: used, commitsPerSecond: used / seconds })}\n`,
);
