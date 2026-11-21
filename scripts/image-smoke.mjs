// Builds the image and proves what a self-hoster gets, on a Docker network that has no way out: the image runs as a
// non-root user in UTC on the pinned Node, ships its version, web build and migrations, applies its migrations, answers
// /readyz with a telemetry endpoint set, and stops cleanly on SIGTERM. Every step fails the script with a message that names it.
// Needs Docker; run with `pnpm verify --only image-smoke`.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const id = `smoke-${randomBytes(4).toString("hex")}`;
const IMAGE = `shoutory-${id}`;
const NETWORK = `${id}-net`;
const CHANNEL = "beta";
const NODE = "/nodejs/bin/node";
const DRAIN_SECONDS = 10;
const READY_ATTEMPTS = 45;

class SmokeFailure extends Error {}

// A path in a volume argument must reach Docker as given: MSYS would rewrite it on Windows.
const env = { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };
function docker(args, { allowFailure = false, timeout = 600_000 } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", env, timeout, cwd: root });
  if (result.error) throw new SmokeFailure(`docker ${args[0]}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new SmokeFailure(
      `docker ${args.slice(0, 2).join(" ")} exited ${result.status}: ${tail(result.stderr)}`,
    );
  }
  return result;
}
const tail = (text) =>
  String(text ?? "")
    .trim()
    .split("\n")
    .slice(-6)
    .join(" | ");
const step = (name) => console.log(`-- ${name}`);
const expect = (condition, message) => {
  if (!condition) throw new SmokeFailure(message);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const secret = () => randomBytes(24).toString("hex");
const roles = ["owner", "app", "worker", "auth", "readonly"];
const passwords = Object.fromEntries(roles.map((role) => [role, secret()]));
const url = (role) => `postgres://shoutory_${role}:${passwords[role]}@postgres:5432/shoutory`;
const appEnv = {
  SHOUTORY_ROLE: "all",
  SHOUTORY_PUBLIC_ORIGIN: "http://localhost:3000",
  SHOUTORY_MAIL_FROM: "Shoutory <noreply@mail.invalid>",
  SHOUTORY_SMTP_URL: "smtp://mail.invalid:25",
  SHOUTORY_HMAC_PEPPER: secret(),
  SHOUTORY_SESSION_SECRET: secret(),
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: randomBytes(32).toString("base64"),
  // The role `all` connects as these three; the owner URL goes to migrate alone.
  ...Object.fromEntries(
    ["app", "auth", "worker"].map((role) => [`SHOUTORY_DATABASE_URL_${role.toUpperCase()}`, url(role)]),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://telemetry.invalid:4318",
};
const envArgs = (values) => Object.entries(values).flatMap(([key, value]) => ["-e", `${key}=${value}`]);

function build() {
  step("build the image");
  docker([
    "build",
    "-f",
    "docker/Dockerfile",
    "--build-arg",
    `SHOUTORY_RELEASE_CHANNEL=${CHANNEL}`,
    "-t",
    IMAGE,
    ".",
  ]);
}

function inspect() {
  step("the image runs as non-root in UTC on the pinned Node, with the channel it was built for");
  const config = JSON.parse(docker(["image", "inspect", "--format", "{{json .Config}}", IMAGE]).stdout);
  expect(/^(nonroot|65532(:65532)?)$/.test(config.User), `the image user is "${config.User}", not non-root`);
  expect(config.Env.includes("TZ=UTC"), "the image does not set TZ=UTC");
  expect(
    config.Env.includes(`SHOUTORY_RELEASE_CHANNEL=${CHANNEL}`),
    "the channel build argument did not reach the image",
  );
  const nvmrc = read(".nvmrc").trim();
  const version = docker(["run", "--rm", "--entrypoint", NODE, IMAGE, "--version"]).stdout.trim();
  expect(version === `v${nvmrc}`, `the runtime Node is ${version}, not v${nvmrc}`);
}

function shipped() {
  step("the image ships the root version, the web build and the migrations");
  const probe = `
    const fs = require("node:fs");
    const files = fs.readdirSync("/app/packages/db/migrations").filter((name) => name.endsWith(".sql"));
    console.log(JSON.stringify({
      version: JSON.parse(fs.readFileSync("/app/package.json", "utf8")).version,
      web: fs.existsSync("/app/apps/web/dist/client/index.html"),
      migrations: files.length,
    }));`;
  const found = JSON.parse(docker(["run", "--rm", "--entrypoint", NODE, IMAGE, "-e", probe]).stdout);
  const wanted = JSON.parse(read("package.json")).version;
  expect(
    found.version === wanted,
    `/app/package.json holds version ${found.version}, the root one is ${wanted}`,
  );
  expect(found.web, "the web build is not at /app/apps/web/dist/client");
  expect(found.migrations > 0, "no migration file is at /app/packages/db/migrations");
}

function startDatabase() {
  step("start PostgreSQL on a network with no way out");
  docker(["network", "create", "--internal", NETWORK]);
  const image = /image: (postgres:\S+)/.exec(read("docker/compose.yml"))?.[1];
  expect(image, "no postgres image in docker/compose.yml");
  docker([
    ...["run", "-d", "--name", `${id}-pg`, "--network", NETWORK, "--network-alias", "postgres"],
    ...envArgs({
      POSTGRES_DB: "shoutory",
      POSTGRES_PASSWORD: secret(),
      ...Object.fromEntries(
        roles.map((role) => [`SHOUTORY_DATABASE_PASSWORD_${role.toUpperCase()}`, passwords[role]]),
      ),
    }),
    ...["-v", `${join(root, "docker/postgres/init.sql")}:/docker-entrypoint-initdb.d/init.sql:ro`, image],
  ]);
}

async function waitFor(label, attempts, check) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return;
    await sleep(2_000);
  }
  throw new SmokeFailure(`${label} did not happen in time`);
}

async function migrate() {
  await waitFor(
    "PostgreSQL accepting connections",
    30,
    () =>
      docker(["exec", `${id}-pg`, "pg_isready", "-h", "127.0.0.1", "-d", "shoutory"], { allowFailure: true })
        .status === 0,
  );
  step("migrate applies every migration as the owner role");
  const result = docker([
    ...["run", "--rm", "--name", `${id}-migrate`, "--network", NETWORK, "--read-only", "--tmpfs", "/tmp"],
    ...envArgs({ SHOUTORY_DATABASE_URL_OWNER: url("owner") }),
    IMAGE,
    "migrate",
  ]);
  expect(/applied /.test(result.stdout), `migrate applied nothing: ${tail(result.stdout)}`);
}

function writeData() {
  step("the non-root user can write to the /data volume");
  const probe = "require('node:fs').writeFileSync('/data/smoke-probe', 'written')";
  docker([
    ...["run", "--rm", "--read-only", "-v", `${id}-data:/data`, "--entrypoint", NODE, IMAGE],
    ...["-e", probe],
  ]);
}

async function startApp() {
  step("start the app read-only with a telemetry endpoint set; /readyz answers 200");
  docker([
    ...["run", "-d", "--name", `${id}-app`, "--network", NETWORK, "--read-only", "--tmpfs", "/tmp"],
    ...["-v", `${id}-data:/data`],
    ...envArgs(appEnv),
    IMAGE,
  ]);
  const probe =
    "fetch('http://127.0.0.1:3000/readyz').then((a)=>process.exit(a.status===200?0:1),()=>process.exit(1))";
  await waitFor(
    "/readyz answering 200",
    READY_ATTEMPTS,
    () => docker(["exec", `${id}-app`, NODE, "-e", probe], { allowFailure: true }).status === 0,
  );
}

function stop() {
  step(`SIGTERM stops the idle container with exit 0 within ${DRAIN_SECONDS} s`);
  const started = Date.now();
  docker(["kill", "--signal", "SIGTERM", `${id}-app`]);
  const waited = docker(["wait", `${id}-app`], { timeout: (DRAIN_SECONDS + 5) * 1000 });
  expect(waited.stdout.trim() === "0", `the container exited ${waited.stdout.trim()} on SIGTERM, not 0`);
  expect(
    Date.now() - started < DRAIN_SECONDS * 1000,
    `the container took more than ${DRAIN_SECONDS} s to stop`,
  );
}

function cleanUp() {
  for (const name of [`${id}-app`, `${id}-migrate`, `${id}-pg`])
    docker(["rm", "-fv", name], { allowFailure: true });
  docker(["network", "rm", NETWORK], { allowFailure: true });
  docker(["volume", "rm", "-f", `${id}-data`], { allowFailure: true });
  docker(["image", "rm", "-f", IMAGE], { allowFailure: true });
}

// An interrupted run still removes what it started.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    cleanUp();
    process.exit(code);
  });
}

try {
  build();
  inspect();
  shipped();
  startDatabase();
  await migrate();
  writeData();
  await startApp();
  stop();
  console.log("image-smoke: pass");
} catch (error) {
  console.error(`image-smoke: FAIL: ${error instanceof SmokeFailure ? error.message : error}`);
  const logs = docker(["logs", "--tail", "20", `${id}-app`], { allowFailure: true });
  if (logs.stdout || logs.stderr) console.error(`app log: ${tail(logs.stdout)} ${tail(logs.stderr)}`);
  process.exitCode = 1;
} finally {
  cleanUp();
}
