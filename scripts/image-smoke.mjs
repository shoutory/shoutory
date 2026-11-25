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
  ...Object.fromEntries(
    ["app", "auth", "worker"].map((role) => [`SHOUTORY_DATABASE_URL_${role.toUpperCase()}`, url(role)]),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://telemetry:4318",
};
const QUERY_CANARY = "span-query-canary-1";
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

// The rows run independently, for both tools, so every failure is reported together.
const TOOL_ROWS = (tool) => [
  [
    "starts on a read-only root with no network as the image's user",
    ["-version"],
    (out) => expect(new RegExp(`^${tool} version `).test(out), `-version printed: ${tail(out)}`),
  ],
  [
    "is LGPL: -buildconf has no --enable-gpl or --enable-nonfree",
    ["-buildconf"],
    (out) =>
      expect(
        !/--enable-(gpl|nonfree)/.test(out) && out.includes("--disable-everything"),
        "-buildconf is not LGPL-only",
      ),
  ],
  [
    "names the GNU Lesser General Public License: -L",
    ["-L"],
    // The licence text wraps lines, so the words are compared with their white space collapsed.
    (out) => {
      const text = out.replaceAll(/\s+/g, " ");
      expect(
        /GNU Lesser General Public License/.test(text) &&
          !/terms of the GNU General Public License/.test(text),
        `-L printed: ${tail(out)}`,
      );
    },
  ],
  [
    "reads only local files: -protocols lists file and no network protocol as input",
    ["-protocols"],
    (out) => {
      const input = /Input:\n([\s\S]*?)\nOutput:/
        .exec(out)?.[1]
        .split("\n")
        .map((line) => line.trim());
      expect(
        JSON.stringify(input) === '["file"]',
        `input protocols are ${JSON.stringify(input)}, not only file`,
      );
    },
  ],
];

function videoTools() {
  const failures = [];
  for (const tool of ["ffprobe", "ffmpeg"])
    for (const [what, args, check] of TOOL_ROWS(tool)) {
      const title = `the image's ${tool} ${what}`;
      step(title);
      const run = docker(
        [
          "run",
          "--rm",
          "--read-only",
          "--network",
          "none",
          "--entrypoint",
          `/usr/local/bin/${tool}`,
          IMAGE,
        ].concat(["-hide_banner", ...args]),
        { allowFailure: true },
      );
      try {
        expect(run.status === 0, `${tool} ${args[0]} exited ${run.status} in the image: ${tail(run.stderr)}`);
        check(`${run.stdout}${run.stderr}`);
      } catch (error) {
        if (!(error instanceof SmokeFailure)) throw error;
        failures.push(`${title}: ${error.message}`);
      }
    }
  expect(failures.length === 0, failures.join(" || "));
}

const VIDEO_FIXTURE = join(root, "apps/api/test/fixtures/h264.mp4");
function probeVideo() {
  step("the shipped probe reads a real mp4 with the production argv, read-only and offline");
  const script = `import("/app/apps/api/dist/jobs/media/probe-run.js")
    .then((probe) => probe.runProbe({ ffprobePath: "/usr/local/bin/ffprobe", inputPath: "/probe/input.mp4", demuxer: "mov" }))
    .then((result) => console.log(JSON.stringify(result)));`;
  const run = docker(
    ["run", "--rm", "--read-only", "--network", "none", "-v", `${VIDEO_FIXTURE}:/probe/input.mp4:ro`].concat([
      "--entrypoint",
      NODE,
      IMAGE,
      "-e",
      script,
    ]),
    { allowFailure: true },
  );
  expect(run.status === 0, `the shipped probe did not run (exit ${run.status}): ${tail(run.stderr)}`);
  const wanted = { ok: true, width: 320, height: 240, durationMs: 2000, codec: "h264", family: "mov" };
  const found = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null");
  expect(
    Object.entries(wanted).every(([key, value]) => found?.[key] === value),
    `the shipped probe answered ${JSON.stringify(found)}, not ${JSON.stringify(wanted)}`,
  );
}

// Inside the container: plant a location in a QuickTime movie (its udta key) and in an mp4 (Apple's metadata key), run
// the shipped copy on each, and report what ffprobe and the bytes show before and after.
const GPS = "+40.7128-074.0060/";
const STRIP_SCRIPT = `
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const run = (tool, args) => {
  const quiet = tool === "ffmpeg" ? ["-nostdin", "-v", "error"] : ["-v", "error"];
  const ended = spawnSync("/usr/local/bin/" + tool, [...quiet, ...args], { encoding: "utf8" });
  if (ended.status !== 0) throw new Error(tool + " exited " + ended.status + ": " + ended.stderr);
  return ended.stdout;
};
const facts = (path) => {
  const json = JSON.parse(run("ffprobe", ["-of", "json", "-show_format", "-show_streams", path]));
  const video = json.streams.find((stream) => stream.codec_type === "video");
  return { tags: JSON.stringify(json.format.tags ?? {}), video: [video.codec_name, video.width, video.height] };
};
const planted = {
  "/work/gps.mov": ["-metadata", "location=${GPS}", "-f", "mov"],
  "/work/gps.mp4": ["-metadata", "com.apple.quicktime.location.ISO6709=${GPS}", "-movflags", "use_metadata_tags", "-f", "mp4"],
};
import("/app/apps/api/dist/jobs/media/probe-run.js").then(async ({ runRemux }) => {
  const results = [];
  for (const [path, how] of Object.entries(planted)) {
    run("ffmpeg", ["-f", "mov", "-i", "/probe/input.mp4", "-c", "copy", ...how, path]);
    const out = path + ".stripped";
    const type = path.endsWith(".mov") ? "video/quicktime" : "video/mp4";
    const copied = await runRemux({ ffmpegPath: "/usr/local/bin/ffmpeg", inputPath: path, outputPath: out, type });
    const bytes = readFileSync(out);
    results.push({
      path, copied, before: facts(path), after: facts(out),
      coordinate: bytes.includes("40.7128"), xyz: bytes.includes(Buffer.from([0xa9, 0x78, 0x79, 0x7a])),
    });
  }
  console.log(JSON.stringify(results));
});`;

function stripVideo() {
  step(
    "the shipped copy drops a planted location from a QuickTime movie and an mp4 and keeps the picture, offline",
  );
  const run = docker(
    [
      "run",
      "--rm",
      "--read-only",
      "--network",
      "none",
      "--tmpfs",
      "/work:size=64m,uid=65532,gid=65532",
    ].concat(["-v", `${VIDEO_FIXTURE}:/probe/input.mp4:ro`, "--entrypoint", NODE, IMAGE, "-e", STRIP_SCRIPT]),
    { allowFailure: true },
  );
  expect(run.status === 0, `the shipped copy did not run (exit ${run.status}): ${tail(run.stderr)}`);
  const results = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "[]");
  expect(results.length === 2, `the copy reported ${results.length} files, not 2`);
  for (const result of results) {
    const said = `${result.path}: ${JSON.stringify(result)}`;
    expect(result.before.tags.includes("40.7128"), `the location was not planted in ${said}`);
    expect(result.copied.ok === true, `the copy failed on ${said}`);
    expect(
      !/40\.7128|location|ISO6709/i.test(result.after.tags),
      `ffprobe still shows a location in ${said}`,
    );
    expect(!result.coordinate && !result.xyz, `the copy's bytes still hold the location in ${said}`);
    const same = JSON.stringify(result.before.video) === JSON.stringify(result.after.video);
    expect(same && result.after.video[0] === "h264", `the picture changed in ${said}`);
  }
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

// A collector that prints every OTLP request body as one line; the image's own Node runs it, so nothing is pulled.
function startCollector() {
  step("start a collector the app exports its spans to");
  const script = `require("node:http").createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { console.log(body.replace(/\\s+/g, " ")); res.end("{}"); });
  }).listen(4318);`;
  docker([
    ...["run", "-d", "--name", `${id}-collector`, "--network", NETWORK, "--network-alias", "telemetry"],
    ...["--read-only", "--entrypoint", NODE, IMAGE, "-e", script],
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

function probeWithQuery() {
  step("one request with a query string, for the incoming-request span");
  const probe = `fetch('http://127.0.0.1:3000/readyz?probe=${QUERY_CANARY}').then(()=>process.exit(0),()=>process.exit(1))`;
  docker(["exec", `${id}-app`, NODE, "-e", probe]);
}

// Kind 2 is a server span; shutdown flushes the spans to the collector.
function receivedSpans() {
  const lines = docker(["logs", `${id}-collector`])
    .stdout.split("\n")
    .filter((line) => line.startsWith("{"));
  return lines.flatMap((line) =>
    JSON.parse(line).resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) =>
        scope.spans.map((span) => ({
          kind: span.kind,
          attributes: Object.fromEntries(
            span.attributes.map(({ key, value }) => [key, value.stringValue ?? String(value.intValue ?? "")]),
          ),
        })),
      ),
    ),
  );
}

function checkSpans() {
  step("the incoming request is one server span, and the query string never reaches the collector");
  const spans = receivedSpans();
  const everything = JSON.stringify(spans);
  expect(!everything.includes(QUERY_CANARY), "the query string reached the collector");
  const withQuery = spans.filter((span) => span.kind === 2 && span.attributes["url.query"] !== undefined);
  expect(
    withQuery.length === 1 && withQuery[0].attributes["url.query"] === "[Redacted]",
    `expected one server span with the query redacted, found ${withQuery.length} of ${spans.length} spans`,
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
  for (const name of [`${id}-app`, `${id}-collector`, `${id}-migrate`, `${id}-pg`])
    docker(["rm", "-fv", name], { allowFailure: true });
  docker(["network", "rm", NETWORK], { allowFailure: true });
  docker(["volume", "rm", "-f", `${id}-data`], { allowFailure: true });
  docker(["image", "rm", "-f", IMAGE], { allowFailure: true });
}

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
  videoTools();
  probeVideo();
  stripVideo();
  startDatabase();
  startCollector();
  await migrate();
  writeData();
  await startApp();
  probeWithQuery();
  stop();
  checkSpans();
  console.log("image-smoke: pass");
} catch (error) {
  console.error(`image-smoke: FAIL: ${error instanceof SmokeFailure ? error.message : error}`);
  const logs = docker(["logs", "--tail", "20", `${id}-app`], { allowFailure: true });
  if (logs.stdout || logs.stderr) console.error(`app log: ${tail(logs.stdout)} ${tail(logs.stderr)}`);
  process.exitCode = 1;
} finally {
  cleanUp();
}
