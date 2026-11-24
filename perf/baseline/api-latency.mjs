// Run alone after a build, from the repository root (needs Docker; refuses to start when another container runs):
//
//   node perf/baseline/api-latency.mjs [idle seconds, default 300]
//
// An organization holds at most 100 workspaces and the per-address sign-in bucket holds 60 tokens and refills
// one every 15 s, so there are 5 organizations and each size waits for the bucket before its 50 sign-ins.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";

const { startStack, flagRemovalDate, APP_ORIGIN } = await import("../../e2e/support/stack.ts");
const { waitForLink } = await import("../../e2e/support/mail.ts");

const IDLE_SECONDS = Number(process.argv[2] ?? 300);
const ORGANIZATIONS = 5;
const PER_ORGANIZATION = 100;
const SIGN_INS = 50;
const LIST_READS = 200;
const BUCKET_REFILL_SECONDS = 660; // 41 tokens at one per 15 s, so 50 sign-ins fit again
const SIZES = [
  { label: "unconstrained" },
  { label: "2 vCPU / 2 GB", cpus: "2", memory: "2g" },
  { label: "1 vCPU / 1 GB", cpus: "1", memory: "1g" },
];

const log = (line) => process.stderr.write(`${line}\n`);
const sleep = (seconds) => new Promise((done) => setTimeout(done, seconds * 1000));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" }).stdout.trim();

const percentile = (sorted, share) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)];
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (ms) => Math.round(ms * 10) / 10;
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1)),
  };
};

if (docker("ps", "-q") !== "") throw new Error("another container is running: a measurement runs alone");

let cookies = "";
const call = async (method, path, body) => {
  const started = performance.now();
  const answer = await fetch(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "X-Shoutory-Client": "web",
      cookie: cookies,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const ms = performance.now() - started;
  const text = await answer.text();
  if (!answer.ok) throw new Error(`${method} ${path} answered ${answer.status}: ${text.slice(0, 400)}`);
  const jar = answer.headers.getSetCookie().map((line) => line.split(";")[0]);
  return { ms, jar, json: text ? JSON.parse(text) : undefined };
};

function memoryMiB(id) {
  const [number, unit] = /([\d.]+)(KiB|MiB|GiB)/
    .exec(docker("stats", "--no-stream", "--format", "{{.MemUsage}}", id))
    .slice(1);
  return Math.round(Number(number) * { KiB: 1 / 1024, MiB: 1, GiB: 1024 }[unit] * 10) / 10;
}
const containerOf = (project, service) =>
  docker(
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  );

const stack = startStack(flagRemovalDate());
try {
  process.env.SHOUTORY_E2E_MAIL_URL = stack.mailUrl;
  const app = containerOf(stack.project, "shoutory");
  const database = containerOf(stack.project, "postgres");
  const account = {
    name: "perf owner",
    email: `perf-${randomBytes(4).toString("hex")}@e2e.test`,
    password: randomBytes(18).toString("base64url"),
  };

  await call("POST", "/api/auth/sign-up/email", account);
  const link = await waitForLink({ to: account.email, path: "/auth/verify" });
  await call("POST", "/api/auth/verify-email", {
    token: new URLSearchParams(new URL(link).hash.slice(1)).get("token"),
  });
  const signIn = async () =>
    call("POST", "/api/auth/sign-in/email", { email: account.email, password: account.password });
  cookies = (await signIn()).jar.join("; ");
  const first = (await call("POST", "/api/v1/organizations", { name: "perf org 1", type: "agency" })).json
    .data;
  await call("POST", "/api/v1/workspaces", {
    organization_id: first.id,
    name: "perf first",
    default_tz: "UTC",
  });

  log(`idle for ${IDLE_SECONDS} s with one organization and one workspace`);
  await sleep(IDLE_SECONDS);
  const idle = { appMiB: memoryMiB(app), databaseMiB: memoryMiB(database) };

  const creates = [];
  const organizations = [
    first,
    ...(
      await Promise.all(
        Array.from({ length: ORGANIZATIONS - 1 }, (_, at) =>
          call("POST", "/api/v1/organizations", { name: `perf org ${at + 2}`, type: "agency" }),
        ),
      )
    ).map((made) => made.json.data),
  ];
  for (const [at, organization] of organizations.entries()) {
    for (let count = at === 0 ? 1 : 0; count < PER_ORGANIZATION; count += 1) {
      const made = await call("POST", "/api/v1/workspaces", {
        organization_id: organization.id,
        name: `perf ${at}-${count}`,
        default_tz: "UTC",
      });
      creates.push(made.ms);
    }
  }
  const afterLoadMiB = memoryMiB(app);

  const sizes = [];
  for (const [at, size] of SIZES.entries()) {
    if (size.cpus)
      docker("update", "--cpus", size.cpus, "--memory", size.memory, "--memory-swap", size.memory, app);
    if (at > 0) await sleep(BUCKET_REFILL_SECONDS);
    await sleep(10);
    const signIns = [];
    for (let count = 0; count < SIGN_INS; count += 1) signIns.push((await signIn()).ms);
    const reads = [];
    for (let count = 0; count < LIST_READS; count += 1)
      reads.push((await call("GET", "/api/v1/workspaces?limit=50")).ms);
    sizes.push({
      size: size.label,
      signIn: summary(signIns),
      workspaceList: summary(reads),
      appMiB: memoryMiB(app),
    });
    log(
      `${size.label}: sign-in p95 ${sizes.at(-1).signIn.p95} ms, list p95 ${sizes.at(-1).workspaceList.p95} ms`,
    );
  }
  const machine = {
    cpu: os.cpus()[0]?.model,
    threads: os.cpus().length,
    ramGiB: Math.round(os.totalmem() / 2 ** 30),
    platform: `${os.type()} ${os.release()}`,
    node: process.version,
  };
  process.stdout.write(
    `${JSON.stringify({ machine, idleSeconds: IDLE_SECONDS, idle, afterLoadMiB, workspaces: ORGANIZATIONS * PER_ORGANIZATION, create: summary(creates), sizes })}\n`,
  );
} finally {
  stack.down();
}
