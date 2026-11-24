import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const cli = join(root, "node_modules/@playwright/test/cli.js");
const EVERY_SHARD = ["journey", "founder"];

// What `playwright test --list` reports for one shard (none = the whole run). Listing loads the specs and reports them;
// it never starts the global setup, and the dead Docker address makes a run that tried to start the stack fail here.
function listed(shard, ci = false) {
  const env = { ...process.env, DOCKER_HOST: "tcp://127.0.0.1:1" };
  env.SHOUTORY_E2E_SHARD = shard ?? "";
  if (shard === undefined) delete env.SHOUTORY_E2E_SHARD;
  if (ci) env.CI = "true";
  else delete env.CI;
  const args = ["test", "--list", "--reporter=json", "--config", "e2e/playwright.config.ts"];
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { run, report: run.status === 0 ? JSON.parse(run.stdout) : undefined };
}

const identities = (report) => {
  const walk = (suite) => [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests.map((one) => `${one.projectName}|${spec.file}|${spec.title}`),
    ),
    ...(suite.suites ?? []).flatMap(walk),
  ];
  return report.suites.flatMap(walk);
};

test("every test runs in exactly one shard, and journey and founder in all", () => {
  const table = JSON.parse(readFileSync(join(root, "e2e/shards.json"), "utf8"));
  const shards = Object.keys(table);
  assert.ok(shards.length > 1, "the shard table names fewer than two shards");
  const whole = listed();
  assert.equal(whole.run.status, 0, whole.run.stderr);
  const perShard = Object.fromEntries(
    shards.map((name) => {
      const answer = listed(name);
      assert.equal(answer.run.status, 0, `${name}: ${answer.run.stderr}`);
      return [name, new Set(identities(answer.report))];
    }),
  );
  const all = identities(whole.report);
  assert.ok(all.length > 0, "the unsharded run lists no test");
  // A project the config defines (the visual ones exist only where baselines are made) must list a test in its shard,
  // so a title filter that matches nothing cannot pass in silence.
  const defined = new Set(whole.report.config.projects.map((project) => project.name));
  for (const [shard, projects] of Object.entries(table)) {
    for (const project of projects.filter((name) => defined.has(name))) {
      const lists = [...perShard[shard]].some((identity) => identity.startsWith(`${project}|`));
      assert.ok(lists, `${shard}: the ${project} project lists no test`);
    }
  }
  for (const identity of all) {
    const holders = shards.filter((name) => perShard[name].has(identity));
    const shared = EVERY_SHARD.includes(identity.split("|")[0]);
    assert.equal(
      holders.length,
      shared ? shards.length : 1,
      `${identity} runs in ${holders.length} shard(s)`,
    );
  }
  const known = new Set(all);
  for (const name of shards) {
    for (const identity of perShard[name])
      assert.ok(known.has(identity), `${name} lists an unknown ${identity}`);
  }
});

test("in every shard each project after the founder project depends on it, directly or through others", () => {
  const table = JSON.parse(readFileSync(join(root, "e2e/shards.json"), "utf8"));
  for (const shard of Object.keys(table)) {
    const answer = listed(shard);
    assert.equal(answer.run.status, 0, `${shard}: ${answer.run.stderr}`);
    const projects = new Map(
      answer.report.config.filteredProjects.map((project) => [project.name, project.dependencies]),
    );
    const reaches = (name, seen = new Set()) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return (projects.get(name) ?? []).some((next) => next === "founder" || reaches(next, seen));
    };
    for (const name of projects.keys()) {
      if (EVERY_SHARD.includes(name)) continue;
      assert.ok(reaches(name), `${shard}: the ${name} project does not run after the founder project`);
    }
  }
});

test("a shard stops after ten failed tests on CI, and a local run has no limit", () => {
  assert.equal(listed("rest", true).report.config.maxFailures, 10);
  assert.equal(listed("rest", false).report.config.maxFailures, 0);
});

test("an unknown shard name stops the run instead of running nothing", () => {
  const { run } = listed("no-such-shard");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /SHOUTORY_E2E_SHARD/);
});
