import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const load = (file) => parse(readFileSync(join(root, file), "utf8"));

const AREAS = ["web", "api", "worker", "db", "sdk", "cli", "mcp", "docs", "ci"];
const EXPECTED = [
  ...["bug", "feature", "question"].map((name) => `type:${name}`),
  ...AREAS.map((name) => `area:${name}`),
  ...["bluesky", "mastodon", "telegram", "discord"].map((name) => `provider:${name}`),
  ...["needs-repro", "blocked", "needs-decision"].map((name) => `status:${name}`),
  "breaking",
  "good first issue",
  "help wanted",
  "security",
  "dependencies",
  "autorelease: pending",
  "autorelease: tagged",
];

test("labels.yml holds the 24 core labels and the 2 labels the release tool manages, each with colour and description", () => {
  const labels = load(".github/labels.yml");
  assert.deepEqual(labels.map((label) => label.name).sort(), [...EXPECTED].sort());
  for (const label of labels) {
    assert.match(label.color, /^[0-9a-f]{6}$/, label.name);
    assert.ok(label.description?.length > 0, label.name);
  }
});

test("every label description fits the 100 characters GitHub allows", () => {
  for (const label of load(".github/labels.yml")) {
    assert.ok(label.description.length <= 100, label.name);
  }
});

test("labeler.yml labels a pull request with every area label and no other", () => {
  assert.deepEqual(
    Object.keys(load(".github/labeler.yml")).sort(),
    AREAS.map((name) => `area:${name}`).sort(),
  );
});

test("the labeler workflow skips fork pull requests", () => {
  const labeler = load(".github/workflows/labeler.yml");
  assert.equal(labeler.jobs.label.if, "github.event.pull_request.head.repo.full_name == github.repository");
});

test("label sync runs on a push that edits the file or by hand, and only other events dry-run", () => {
  const sync = load(".github/workflows/label-sync.yml");
  assert.deepEqual(sync.on.push, { branches: ["main"], paths: [".github/labels.yml"] });
  assert.ok("workflow_dispatch" in sync.on);
  const run = sync.jobs.sync.steps.find((step) =>
    step.uses?.startsWith("crazy-max/ghaction-github-labeler@"),
  );
  assert.equal(
    run.with["dry-run"],
    "${{ github.event_name != 'push' && github.event_name != 'workflow_dispatch' }}",
  );
});
