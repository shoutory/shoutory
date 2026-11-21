import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  affectedSteps,
  loadPlaceholders,
  pathsFromNul,
  runSteps,
  STEPS,
} from "../../../../scripts/verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ok = [process.execPath, "-e", ""];
const bad = [process.execPath, "-e", "process.exit(3)"];

function run(steps, { files = {}, placeholders = [] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "verify-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), content);
    }
    const lines = [];
    const status = runSteps(steps, { cwd, placeholders, log: (line) => lines.push(line) });
    return { status, output: lines.join("\n") };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const withFile = { files: { "src/a.txt": "a" } };

test("a passing step prints the files it ran", () => {
  const { status, output } = run([{ name: "alpha", globs: ["src/*.txt"], command: ok }], withFile);
  assert.equal(status, 0);
  assert.match(output, /alpha/);
  assert.match(output, /src[\\/]a\.txt/);
});

test("a failing step prints its files and fails the run", () => {
  const { status, output } = run([{ name: "alpha", globs: ["src/*.txt"], command: bad }], withFile);
  assert.notEqual(status, 0);
  assert.match(output, /src[\\/]a\.txt/);
});

test("a step that ran nothing fails unless it is a listed placeholder", () => {
  const steps = [{ name: "beta", globs: ["none/*.txt"], command: ok }];
  const failing = run(steps);
  assert.notEqual(failing.status, 0);
  assert.match(failing.output, /beta/);
  assert.equal(run(steps, { placeholders: ["beta"] }).status, 0);
});

test("a listed placeholder that already has files fails, so its line must be removed", () => {
  const steps = [{ name: "delta", globs: ["src/*.txt"], command: ok }];
  assert.notEqual(run(steps, { ...withFile, placeholders: ["delta"] }).status, 0);
});

test("every placeholder entry names a real step and gives a reason in words", () => {
  const entries = loadPlaceholders(join(root, ".github/ci-placeholders.json"));
  const names = new Set(STEPS.map((step) => step.name));
  for (const entry of entries) {
    assert.ok(names.has(entry.name), `unknown step ${entry.name}`);
    assert.match(entry.reason, /\w+ \w+/);
  }
});

// The selection of a local run: the steps a change can affect.
const FEATURE = "refs/heads/feature";
const selected = (changed, options = {}) =>
  affectedSteps(STEPS, { changed, ref: FEATURE, ...options }).map((step) => step.name);
const ALWAYS = ["unit", "lint", "typecheck", "gitleaks"];

// Each row: what changed, the options, the steps that must run and the steps that must not.
const SELECTIONS = [
  ["docs only", ["docs/guide/x.md"], {}, ["unit", ...ALWAYS], ["e2e", "image-smoke"]],
  ["a web source", ["apps/web/src/a.tsx"], {}, ["e2e", "image-smoke"], []],
  ["an api source", ["apps/api/src/a.ts"], {}, ["e2e", "image-smoke"], []],
  ["a core package", ["packages/core/src/a.ts"], {}, ["e2e", "image-smoke"], []],
  ["a spec only", ["e2e/specs/a.spec.ts"], {}, ["e2e"], ["image-smoke"]],
  ["the Dockerfile", ["docker/Dockerfile"], {}, ["e2e", "image-smoke"], []],
  // A move lists the old path and the new one (`--no-renames`), so leaving a watched folder still selects the steps.
  [
    "a file moved out of a watched folder",
    ["apps/web/src/a.tsx", "packages/testkit/src/a.tsx"],
    {},
    ["e2e", "image-smoke"],
    [],
  ],
  ["the lockfile", ["pnpm-lock.yaml"], {}, ["e2e", "image-smoke"], []],
  ["the root tsconfig", ["tsconfig.json"], {}, ["e2e", "image-smoke"], []],
  ["the base tsconfig", ["tsconfig.base.json"], {}, ["e2e", "image-smoke"], []],
  ["the docker ignore file", [".dockerignore"], {}, ["e2e", "image-smoke"], []],
  ["the image smoke script", ["scripts/image-smoke.mjs"], {}, ["e2e", "image-smoke"], []],
  ["a test-kit source", ["packages/testkit/src/a.ts"], {}, ALWAYS, ["e2e", "image-smoke"]],
  ["the check command", ["scripts/verify.mjs"], {}, STEPS.map((step) => step.name), []],
  ["the workflow", [".github/workflows/ci.yml"], {}, STEPS.map((step) => step.name), []],
  ["docs only with --all", ["docs/guide/x.md"], { all: true }, STEPS.map((step) => step.name), []],
  ["docs only on main", ["docs/guide/x.md"], { ref: "refs/heads/main" }, STEPS.map((step) => step.name), []],
  [
    "docs only on a tag",
    ["docs/guide/x.md"],
    { ref: "refs/tags/v1.0.0" },
    STEPS.map((step) => step.name),
    [],
  ],
  ["an unknown change set", undefined, {}, STEPS.map((step) => step.name), []],
];

test("each changed path selects exactly its steps", () => {
  for (const [label, changed, options, included, excluded] of SELECTIONS) {
    const names = selected(changed, options);
    for (const name of included) assert.ok(names.includes(name), `${label}: ${name} must run`);
    for (const name of excluded) assert.ok(!names.includes(name), `${label}: ${name} must not run`);
  }
});

test("the e2e watch list covers every path the Dockerfile COPYs", () => {
  const dockerfile = readFileSync(join(root, "docker/Dockerfile"), "utf8");
  // `COPY --from=build /app/<dir>/<name> ...`: the first two segments name the workspace the image takes from.
  const copied = [...dockerfile.matchAll(/^COPY --from=build \/app\/((?:apps|packages)\/[^/\s]+)\//gm)].map(
    (match) => match[1],
  );
  assert.ok(copied.length > 0, "no COPY of a workspace was found");
  for (const dir of new Set(copied)) {
    assert.ok(
      selected([`${dir}/src/a.ts`]).includes("e2e"),
      `${dir} is copied into the image but not watched`,
    );
  }
});

test("git's NUL-separated path lists keep a name with a space or a newline whole", () => {
  const diff = "docs/a b.md\0e2e/specs/x\ny.spec.ts\0";
  const added = "apps/web/src/new.tsx\0";
  assert.deepEqual(pathsFromNul(diff, added), [
    "docs/a b.md",
    "e2e/specs/x\ny.spec.ts",
    "apps/web/src/new.tsx",
  ]);
});
