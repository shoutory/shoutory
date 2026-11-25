import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (path) => readFileSync(join(root, path), "utf8");
const dockerfile = existsSync(join(root, "docker/Dockerfile")) ? read("docker/Dockerfile") : "";
const lines = dockerfile.split("\n");
const nvmrc = read(".nvmrc").trim();

test("each image the Dockerfile uses is pinned by digest and says when it was read", () => {
  const pins = [
    [
      new RegExp(`^FROM node:${nvmrc.replaceAll(".", "\\.")}-trixie-slim@sha256:[0-9a-f]{64} AS build`),
      "builder",
    ],
    [/^COPY --from=ghcr\.io\/pnpm\/pnpm:12\.17\.0@sha256:[0-9a-f]{64} /, "pnpm"],
    [/^FROM gcr\.io\/distroless\/nodejs26-debian13:nonroot@sha256:[0-9a-f]{64}/, "runtime"],
  ];
  for (const [pattern, name] of pins) {
    const at = lines.findIndex((line) => pattern.test(line));
    assert.ok(at > 0, `${name}: no pinned line`);
    assert.match(lines[at - 1], /^# .*\b20\d\d-\d\d-\d\d\b/, `${name}: no date above the pin`);
  }
});

test("the runtime stage is distroless and non-root, runs in UTC and takes the channel as a build argument", () => {
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM gcr.io/distroless/"));
  assert.match(runtime, /^USER nonroot$/m);
  assert.match(runtime, /^ENV TZ=UTC$/m);
  assert.match(dockerfile, /^ARG SHOUTORY_RELEASE_CHANNEL=stable$/m);
  assert.match(runtime, /^ENV SHOUTORY_RELEASE_CHANNEL=\$\{SHOUTORY_RELEASE_CHANNEL\}$/m);
  assert.match(runtime, /^ENV SHOUTORY_WEB_ROOT=\/app\/apps\/web\/dist\/client$/m);
  assert.match(runtime, /^VOLUME \/data$/m);
  // The telemetry preload runs before the server module, so the ESM hook is in place when `node:http` loads.
  assert.match(
    runtime,
    /^ENTRYPOINT \["\/nodejs\/bin\/node", "--import", "\/app\/apps\/api\/dist\/telemetry\/preload\.js", "\/app\/apps\/api\/dist\/main\.js"\]$/m,
  );
  assert.doesNotMatch(runtime, /^RUN /m, "a distroless runtime has no shell to run anything");
});

test("the debug stage pins its shell base by digest and date and the last stage is still the distroless nonroot one", () => {
  const debug = lines.findIndex((line) =>
    /^FROM gcr\.io\/distroless\/nodejs26-debian13:debug-nonroot@sha256:[0-9a-f]{64} AS debug$/.test(line),
  );
  assert.ok(debug > 0, "no debug stage");
  assert.match(lines[debug - 1], /^# .*\b20\d\d-\d\d-\d\d\b/, "no date above the debug pin");
  assert.ok(
    lines.some((line) => /^FROM scratch AS app$/.test(line)),
    "no shared app stage",
  );
  const last = lines.findLastIndex((line) => line.startsWith("FROM "));
  assert.match(lines[last], /^FROM gcr\.io\/distroless\/nodejs26-debian13:nonroot@sha256:[0-9a-f]{64}$/);
  assert.ok(debug < last, "the debug stage is not before the default stage");
  const shell = dockerfile.slice(dockerfile.indexOf(lines[debug]), dockerfile.indexOf(lines[last]));
  assert.match(shell, /^USER nonroot$/m);
});

test("the debug and the default runtime bases name the same Node version", () => {
  const versionAbove = (pattern) => {
    const at = lines.findIndex((line) => pattern.test(line));
    assert.ok(at > 0, `no line for ${pattern}`);
    let block = "";
    for (let line = at - 1; line >= 0 && lines[line].startsWith("#"); line -= 1)
      block = `${lines[line]} ${block}`;
    const found = /Node (\d+\.\d+\.\d+)/.exec(block);
    assert.ok(found, `no "Node x.y.z" in the comment above ${pattern}`);
    return found[1];
  };
  const debug = versionAbove(/^FROM gcr\.io\/distroless\/nodejs26-debian13:debug-nonroot@/);
  const base = versionAbove(/^FROM gcr\.io\/distroless\/nodejs26-debian13:nonroot@/);
  assert.equal(debug, base, "the debug image runs another Node than the shipped one");
});

test("the ffmpeg stage uses the build stage's base and a checksummed FFmpeg tarball with an LGPL-only, local-files-only configure line", () => {
  const at = lines.findIndex((line) => /^FROM node:\S+ AS ffmpeg$/.test(line));
  assert.ok(at > 0, "no ffmpeg stage");
  assert.match(
    lines[at - 1],
    /[Ii]ndex digest read 20\d\d-\d\d-\d\d/,
    "no digest-read date on the line above the pin",
  );
  const base = lines.find((line) => /^FROM node:\S+ AS build$/.test(line))?.replace(/ AS build$/, "");
  assert.equal(lines[at], `${base} AS ffmpeg`, "the ffmpeg stage is not on the build stage's base digest");
  const end = lines.findIndex((line, index) => index > at && line.startsWith("FROM "));
  const stage = lines.slice(at, end).join("\n");
  assert.match(
    stage,
    /^ADD --checksum=sha256:[0-9a-f]{64} https:\/\/ffmpeg\.org\/releases\/ffmpeg-\d+\.\d+\.\d+\.tar\.xz /m,
  );
  // The one configure command, comments left out and continuation lines joined: its words are exactly these.
  const command = lines
    .slice(at, end)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replaceAll(/\\\n/g, " ");
  const configures = command.match(/\.\/configure\b[^&|;\n]*/g) ?? [];
  assert.equal(configures.length, 1, "the ffmpeg stage must run ./configure exactly once");
  const options = configures[0].split(/\s+/).slice(1).filter(Boolean).sort();
  assert.deepEqual(options, [
    "--disable-autodetect",
    "--disable-doc",
    "--disable-everything",
    "--disable-ffplay",
    "--disable-network",
    "--disable-x86asm",
    "--enable-demuxer=mov,matroska",
    "--enable-muxer=mp4,mov,webm",
    "--enable-protocol=file",
  ]);
});

test("every ADD of a URL carries a sha256 checksum", () => {
  const adds = lines.filter((line) => /^ADD\b/.test(line) && /\bhttps?:\/\//.test(line));
  assert.ok(adds.length > 0, "no ADD of a URL to check");
  for (const add of adds) assert.match(add, /^ADD --checksum=sha256:[0-9a-f]{64} https?:\/\//, add);
});

test("the nonroot and debug runtime stages copy ffprobe and ffmpeg from the one ffmpeg stage and tell the app where they are", () => {
  const debug = lines.findIndex((line) => / AS debug$/.test(line));
  const last = lines.findLastIndex((line) => line.startsWith("FROM "));
  for (const [name, stage] of [
    ["debug", lines.slice(debug, last).join("\n")],
    ["default", lines.slice(last).join("\n")],
  ]) {
    for (const tool of ["ffprobe", "ffmpeg"]) {
      const copy = new RegExp(`^COPY --from=ffmpeg /usr/local/bin/${tool} /usr/local/bin/${tool}$`, "m");
      const where = new RegExp(`^ENV SHOUTORY_${tool.toUpperCase()}_PATH=/usr/local/bin/${tool}$`, "m");
      assert.match(stage, copy, `the ${name} image lacks ${tool}`);
      assert.match(stage, where, `the ${name} image does not tell the app where ${tool} is`);
    }
  }
});

test("the Dockerfile uses no package runner, corepack or downloader, and apt-get only in the ffmpeg stage with retries", () => {
  assert.ok(dockerfile.length > 0, "there is no docker/Dockerfile");
  for (const word of ["npx", "dlx", "corepack", "curl", "wget"]) {
    assert.doesNotMatch(dockerfile, new RegExp(`\\b${word}\\b`), word);
  }
  for (const stage of dockerfile.split(/^(?=FROM )/m)) {
    const own = /^FROM .* AS ffmpeg$/m.test(stage.split("\n")[0]);
    if (!own)
      assert.doesNotMatch(stage, /\bapt-get\b/, `apt-get outside the ffmpeg stage: ${stage.split("\n")[0]}`);
    for (const call of stage.match(/\bapt-get\b[^\n]*/g) ?? []) {
      assert.match(call, /^apt-get -o Acquire::Retries=5 /, `apt-get without retries: ${call}`);
    }
  }
});

test("the image ships the root package.json and the migrations beside the build, under /app", () => {
  assert.match(dockerfile, /^COPY --from=build .*\/package\.json \/app\/package\.json$/m);
  assert.match(dockerfile, /^COPY --from=build .*packages\/db\/migrations /m);
  assert.match(dockerfile, /^COPY --from=build .*apps\/web\/dist /m);
});

test("the image-smoke script exists, is wired in package.json and is no longer a placeholder", () => {
  assert.equal(JSON.parse(read("package.json")).scripts["image-smoke"], "node scripts/image-smoke.mjs");
  assert.ok(existsSync(join(root, "scripts/image-smoke.mjs")), "no scripts/image-smoke.mjs");
  const names = JSON.parse(read(".github/ci-placeholders.json")).map((entry) => entry.name);
  assert.ok(!names.includes("image-smoke"), "image-smoke is still listed as a placeholder");
});

test("the image-smoke job runs on the native amd64 and arm64 runners, from a static matrix", () => {
  const job = parse(read(".github/workflows/ci.yml")).jobs["image-smoke"];
  assert.equal(job["runs-on"], "${{ matrix.runner }}");
  assert.deepEqual([...job.strategy.matrix.runner].sort(), ["ubuntu-24.04", "ubuntu-24.04-arm"]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.outputs, undefined, "a live job reports no placeholder output");
});

test("the build context leaves out environment files and key material at any depth", () => {
  const ignored = read(".dockerignore").split("\n");
  for (const pattern of ["**/.env", "**/.env.*", "**/*.pem", "**/*.key"]) {
    assert.ok(ignored.includes(pattern), `.dockerignore lacks ${pattern}`);
  }
});
