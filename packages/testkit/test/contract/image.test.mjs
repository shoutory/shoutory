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

// Every image the Dockerfile uses is named by version and digest, with the date its digest was read on the line above.
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
  assert.match(runtime, /^ENTRYPOINT \["\/nodejs\/bin\/node", "\/app\/apps\/api\/dist\/main\.js"\]$/m);
  assert.doesNotMatch(runtime, /^RUN /m, "a distroless runtime has no shell to run anything");
});

test("the Dockerfile downloads nothing and uses no package runner or corepack", () => {
  assert.ok(dockerfile.length > 0, "there is no docker/Dockerfile");
  for (const word of ["npx", "dlx", "corepack", "curl", "wget", "apt-get"]) {
    assert.doesNotMatch(dockerfile, new RegExp(`\\b${word}\\b`), word);
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
