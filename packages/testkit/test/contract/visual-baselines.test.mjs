import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const specs = join(root, "e2e/specs");
const spec = "rtl-visual.spec.ts";
const baselines = join(specs, `${spec}-snapshots`);
// Playwright's own template when a project sets none (the installed version's default for a screenshot).
const DEFAULT_TEMPLATE =
  "{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}";
// The pictures are made on Linux, as in CI; a listing never runs a test, so the platform here is the baselines'.
const PLATFORM = "linux";

// Every visual cell the config lists, as { project, title }. A listing loads the specs and reports them; it never starts
// the stack.
function visualCells() {
  const cli = join(root, "node_modules/@playwright/test/cli.js");
  const args = ["test", "--list", "--reporter=json", "--config", "e2e/playwright.config.ts"];
  const env = { ...process.env, DOCKER_HOST: "tcp://127.0.0.1:1" };
  delete env.SHOUTORY_E2E_SHARD;
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const walk = (suite) => [
    ...(suite.specs ?? []).flatMap((one) =>
      one.file === spec ? one.tests.map((cell) => ({ project: cell.projectName, title: one.title })) : [],
    ),
    ...(suite.suites ?? []).flatMap(walk),
  ];
  return JSON.parse(run.stdout)
    .suites.flatMap(walk)
    .filter((cell) => cell.project.startsWith("visual"));
}

// The picture a cell compares with: the spec names it `<id>-<width>-<locale>-<theme>.png` after the title's cell, and the
// template turns the name into a path (the same tokens Playwright replaces, here for a spec at the top of the test dir).
function pathOf(template, project, title) {
  const match = /^visual: the (\S+) (?:screen|page) matches its baseline \((\d+) px, (\w+), (\w+)\)$/.exec(
    title,
  );
  assert.ok(match, `unreadable visual title: ${title}`);
  const arg = `${match[1]}-${match[2]}-${match[3]}-${match[4]}`;
  const tokens = {
    snapshotDir: specs,
    testFileDir: "",
    testFileName: spec,
    arg,
    projectName: project,
    snapshotSuffix: PLATFORM,
    ext: ".png",
  };
  const filled = template.replace(/\{([^\w}])?(\w+)\}/g, (_, before, name) =>
    tokens[name] ? `${before ?? ""}${tokens[name]}` : "",
  );
  return resolve(filled).replaceAll("\\", "/");
}

test("every committed baseline is the path one listed visual cell resolves to, and every visual cell resolves to a baseline", async () => {
  const { VISUAL_SNAPSHOT_PATH } = await import(pathToFileURL(join(root, "e2e/support/visual.ts")).href);
  const template = VISUAL_SNAPSHOT_PATH ?? DEFAULT_TEMPLATE;
  const cells = visualCells();
  assert.ok(cells.length > 0, "no visual cell is listed");
  const wanted = new Map(cells.map((cell) => [pathOf(template, cell.project, cell.title), cell.title]));
  const committed = new Set(
    readdirSync(baselines).map((file) => resolve(baselines, file).replaceAll("\\", "/")),
  );
  const missing = [...wanted.keys()].filter((path) => !committed.has(path));
  const orphaned = [...committed].filter((path) => !wanted.has(path));
  assert.deepEqual(
    { missing: missing.length, orphaned: orphaned.length },
    { missing: 0, orphaned: 0 },
    `a cell has no baseline (${missing[0]}) or a baseline has no cell (${orphaned[0]})`,
  );
});
