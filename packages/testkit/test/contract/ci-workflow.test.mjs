import { strict as assert } from "node:assert";
import { globSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { IMAGES, STEPS } from "../../../../scripts/verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dir = join(root, ".github/workflows");
const files = () => readdirSync(dir).filter((file) => /\.ya?ml$/.test(file));
const read = (file) => readFileSync(join(dir, file), "utf8");
const checkCommand = /^pnpm verify --only (\S+)$/;
const checkSteps = (job) => (job.steps ?? []).filter((step) => checkCommand.test(step.run ?? ""));
const { ci: aggregate, ...jobs } = parse(read("ci.yml")).jobs;

test("every uses: line is pinned to a 40-character commit SHA with a version comment", () => {
  const actions = globSync(".github/actions/**/action.{yml,yaml}", { cwd: root });
  const lines = [
    ...files().flatMap((file) => read(file).split(/\r?\n/)),
    ...actions.flatMap((file) => readFileSync(join(root, file), "utf8").split(/\r?\n/)),
  ];
  const uses = lines.filter((line) => /^\s*(-\s*)?uses:/.test(line));
  assert.ok(uses.length > 0, "no uses: line scanned");
  const loose = uses.filter((line) => !/uses:\s*(\.\/\S+|\S+@[0-9a-f]{40}\s+# v\d\S*)\s*$/.test(line));
  assert.deepEqual(loose, []);
});

test("no workflow uses pull_request_target or workflow_run", () => {
  assert.ok(files().length > 0);
  for (const file of files()) {
    assert.doesNotMatch(JSON.stringify(parse(read(file)).on), /pull_request_target|workflow_run/, file);
  }
});

test("the ci aggregate job runs always and needs every other job", () => {
  assert.ok(Object.keys(jobs).length > 0);
  assert.equal(aggregate.if, "always()");
  assert.deepEqual([...aggregate.needs].sort(), Object.keys(jobs).sort());
});

test("every job runs exactly one check-command step and every check-command step has a job", () => {
  const ran = Object.entries(jobs).map(([id, job]) => {
    const steps = checkSteps(job);
    assert.equal(steps.length, 1, `${id} must run one check-command step`);
    assert.equal(steps[0].run.match(checkCommand)[1], id, `${id} must run the step of its own name`);
    return id;
  });
  assert.deepEqual(ran.sort(), STEPS.map((step) => step.name).sort());
});

test("scanner image references are identical in the workflow and the check command and carry a digest", () => {
  const text = read("ci.yml");
  for (const [name, reference] of Object.entries(IMAGES)) {
    assert.match(reference, /@sha256:[0-9a-f]{64}$/, name);
    assert.ok(text.includes(reference), `${name}: reference missing from the workflow`);
    assert.ok(
      jobs[name].steps.some((step) => step.run === `docker pull ${reference}`),
      name,
    );
    assert.ok(STEPS.find((step) => step.name === name).command.includes(reference), name);
  }
});

test("zizmor reads every workflow and composite action; actionlint, which rejects action files, the workflows", () => {
  const globs = (name) => STEPS.find((step) => step.name === name).globs;
  assert.deepEqual(globs("actionlint"), [".github/workflows/*.{yml,yaml}"]);
  assert.deepEqual(globs("zizmor"), [
    ".github/workflows/*.{yml,yaml}",
    ".github/actions/**/action.{yml,yaml}",
  ]);
});

test("the gitleaks step scans the history of the checked-out branch, not every ref", () => {
  const { command } = STEPS.find((step) => step.name === "gitleaks");
  assert.ok(command.includes(`--log-opts=${process.env.GITLEAKS_LOG_OPTS || "HEAD"}`));
});

test("placeholder steps run a named package script and image-smoke and upgrade scan different files", () => {
  const find = (name) => STEPS.find((step) => step.name === name);
  for (const name of ["build", "e2e", "image-smoke", "upgrade"]) {
    assert.deepEqual(find(name).command.slice(-2), ["run", name], `${name} must run its own script`);
  }
  assert.notDeepEqual(find("upgrade").globs, find("image-smoke").globs);
});

test("a placeholder step scans only the files that make it live, so earlier files never break it", () => {
  const globs = (name) => STEPS.find((step) => step.name === name).globs;
  assert.deepEqual(globs("image-smoke"), ["docker/Dockerfile*"]);
  assert.deepEqual(globs("build"), ["apps/api/src/main.ts"]);
});

test("the integration job runs the role script twice, probes the database on the loopback address and keeps the admin URL out of the job env", () => {
  const job = jobs.integration;
  const roleSteps = job.steps.filter((step) => (step.run ?? "").includes("docker/postgres/init.sql"));
  assert.ok(roleSteps.length >= 2, "the role script must run twice to prove it is idempotent");
  assert.match(job.services.postgres.options, /pg_isready -h 127\.0\.0\.1/);
  assert.equal(job.env.SHOUTORY_TEST_ADMIN_URL, undefined);
  const verify = job.steps.find((step) => checkCommand.test(step.run ?? ""));
  assert.ok(verify.env.SHOUTORY_TEST_ADMIN_URL, "only the step that runs the tests holds the admin URL");
});

test("the integration job starts the S3 simulator by digest, waits for it and gives only the test step its address", () => {
  const job = jobs.integration;
  const start = job.steps.findIndex((step) =>
    /docker run .*versity\/versitygw:v[\d.]+@sha256:[0-9a-f]{64}/s.test(step.run ?? ""),
  );
  assert.ok(start >= 0, "a step must start the pinned S3 gateway image");
  assert.ok(job.steps[start].run.includes("--tmpfs /data") && job.steps[start].run.includes("posix /data"));
  assert.match(
    job.steps[start + 1].run,
    /curl .*http_code.*127\.0\.0\.1:7070/s,
    "the next step must wait for it",
  );
  const verify = job.steps.findIndex((step) => checkCommand.test(step.run ?? ""));
  assert.ok(start + 1 < verify, "the simulator must be ready before the tests run");
  assert.equal(job.steps[verify].env.SHOUTORY_TEST_S3_URL, "http://127.0.0.1:7070");
  assert.equal(job.env.SHOUTORY_TEST_S3_URL, undefined);
});

test("the screenshot update input reaches Playwright only through env, and the artifact holds screenshots only", () => {
  const ci = parse(read("ci.yml"));
  assert.equal(ci.on.workflow_dispatch.inputs["update-visual-snapshots"].type, "boolean");
  const job = jobs.e2e;
  for (const step of job.steps) {
    assert.doesNotMatch(step.run ?? "", /\$\{\{/, "an expression inside a run string");
  }
  const verify = job.steps.find((step) => step.run === "pnpm verify --only e2e");
  assert.match(verify.env.SHOUTORY_E2E_UPDATE_VISUAL, /inputs\.update-visual-snapshots/);
  const upload = job.steps.find((step) => (step.uses ?? "").startsWith("actions/upload-artifact@"));
  assert.match(upload.with.path, /\.png$/, "the artifact holds more than screenshots");
  // Only a run asked to update, and only when the e2e step passed: pictures of a failed run are never uploaded.
  assert.match(upload.if, /inputs\.update-visual-snapshots/, "the upload is not gated by the input");
  assert.match(upload.if, /success\(\)/, "the upload does not wait for the e2e step to pass");
  assert.doesNotMatch(upload.if, /cancelled|always|failure/, "the upload runs after a failed run");
  assert.deepEqual(job.permissions, { contents: "read" });
});

test("the package manager is set up before node and no job restores a package cache", () => {
  for (const [id, job] of Object.entries(jobs)) {
    const uses = job.steps.map((step) => step.uses ?? "");
    const pnpm = uses.findIndex((ref) => ref.startsWith("pnpm/action-setup@"));
    const node = uses.findIndex((ref) => ref.startsWith("actions/setup-node@"));
    assert.ok(pnpm >= 0 && pnpm < node, `${id}: pnpm/action-setup must come before setup-node`);
    assert.equal(job.steps[node].with["package-manager-cache"], false, id);
  }
});
