import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = resolve(dirname(fileURLToPath(import.meta.url)), "check-no-planning-paths.mjs");

// Planted values are assembled at run time so this file never contains them literally.
const planted = {
  "a planning path": ["see ", "docs", "/", "plans", "/x for details"].join(""),
  "an ADR number": ["decided in ", "AD", "R-", "12"].join(""),
  "a slice id": ["built in ", "M", "3-", "07"].join(""),
  "a plan label": ["label ", "OD", "-M", "4"].join(""),
  "a ruling id": ["checked in ", "R", "123"].join(""),
  "a one-digit ruling id": ["refused by ", "R", "1"].join(""),
  "a two-digit ruling id": ["decided by ", "R", "42"].join(""),
  "a rule number": ["as in ", "AGENTS", " 3.7"].join(""),
  "a ledger spec row": ["see ", "O", "L 4.4"].join(""),
  "a verification id": ["covered by ", "V", "-48"].join(""),
  "a requirement id": ["limit of ", "NFR", "-SEC-28"].join(""),
  "a feature id": ["for ", "F", "-TEAM-006"].join(""),
  "an open question id": ["per ", "Q", "-M1"].join(""),
  "a security case id": ["case ", "SSR", "F-04"].join(""),
  "a walkthrough id": ["step ", "WI", "-F11"].join(""),
  "a bug case id": ["case ", "BG", "-8"].join(""),
  "an edge case id": ["case ", "E", "-1"].join(""),
  "a security set name": ["the ", "H", "3 set"].join(""),
  "a ledger spec term": ["the ", "O", "L transition rows"].join(""),
  "a policy template name": ["the ", "template ", "U policy"].join(""),
  "a provider class name": ["a ", "class ", "E provider"].join(""),
  "a data model phrase": ["as the ", "data", " model states"].join(""),
  "a spike id": ["chosen by ", "SP", "-11"].join(""),
  "a lone milestone token": ["added in ", "M", "4."].join(""),
  "a milestone-prefixed file name": ["see ", "m", "0-baseline.md"].join(""),
  "a milestone-suffixed file name": ["run ", "a11y-", "m", "0.spec.ts"].join(""),
  "a milestone folder": ["node ", "perf/", "m", "1/run.mjs"].join(""),
  "a journey id": ["the ", "J", "1 journey"].join(""),
  "a journey-prefixed file name": ["run ", "e2e/specs/", "j", "1-onboarding.spec.ts"].join(""),
  "a read-back class letter": ["a ", "class ", "B provider"].join(""),
  "a policy template letter": ["the ", "template ", "W policy"].join(""),
  "a flows section": ["see ", "flows", " 1.3"].join(""),
  "a data model document": ["see the ", "data", "-model"].join(""),
  "a ux spec document": ["see the ", "ux", "-spec"].join(""),
};

function runGuard(files, afterAdd) {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    execFileSync("git", ["add", "-A"], { cwd: dir });
    afterAdd?.(dir);
    return spawnSync(process.execPath, [guard], { cwd: dir, encoding: "utf8" }).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, line] of Object.entries(planted)) {
  test(`the guard exits non-zero for ${label} in a tracked file`, () => {
    assert.notEqual(runGuard({ "src/note.txt": `${line}\n` }), 0);
  });
}

test("the guard exits non-zero for a tracked file whose path is a planning path", () => {
  assert.notEqual(runGuard({ [["docs", "prd", "a.md"].join("/")]: "plain text\n" }), 0);
});

test("the guard exits zero for a clean tree", () => {
  assert.equal(runGuard({ "src/index.txt": "plain text\n", "README.txt": "hello\n" }), 0);
});

test("the guard exits zero for product words next to the cited ones", () => {
  assert.equal(
    runGuard({ "src/a.txt": "the connect flows end here, version V8, owner of the lease, AGENTS.md\n" }),
    0,
  );
});

test("the guard exits non-zero for a citation in any migration, applied or new", () => {
  for (const name of ["0008_audit.sql", "0030_new.sql"]) {
    assert.notEqual(runGuard({ [`packages/db/migrations/${name}`]: `-- ${planted["a ruling id"]}\n` }), 0);
  }
});

test("the guard skips a tracked file that was deleted from the checkout", () => {
  assert.equal(
    runGuard({ "src/gone.txt": "plain text\n" }, (dir) => rmSync(join(dir, "src/gone.txt"))),
    0,
  );
});

test("the guard fails on a read error other than a missing or unreadable file", () => {
  const status = runGuard({ "src/swap.txt": "plain text\n" }, (dir) => {
    rmSync(join(dir, "src/swap.txt"));
    mkdirSync(join(dir, "src/swap.txt"));
  });
  assert.notEqual(status, 0);
});

test("the guard ignores untracked files", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, "loose.txt"), `${planted["a slice id"]}\n`);
    assert.equal(spawnSync(process.execPath, [guard], { cwd: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
