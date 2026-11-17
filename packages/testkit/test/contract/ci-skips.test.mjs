import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runSteps } from "../../../../scripts/verify.mjs";

const REPORT = ".artifacts/report.json";
const node = (...args) => [process.execPath, ...args];
const report = (pending, todo) =>
  node(
    "-e",
    `require("fs").mkdirSync(".artifacts", { recursive: true });
     require("fs").writeFileSync("${REPORT}", JSON.stringify({ numPendingTests: ${pending}, numTodoTests: ${todo} }))`,
  );
const nodeTest = { command: node("--test", "--test-reporter=tap"), appendFiles: true, skips: "node-test" };
const unitReport = (pending, todo) => ({ command: report(pending, todo), skips: { json: REPORT } });

// Runs steps in a temporary folder holding `files`; a nested test run must not inherit the outer reporter.
function inFolder(files, steps, options = () => ({})) {
  const cwd = mkdtempSync(join(tmpdir(), "steps-"));
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), content);
    }
    const lines = [];
    const status = runSteps(steps, { cwd, log: (line) => lines.push(line), ...options(cwd) });
    const read = (name) => [name, existsSync(join(cwd, name)) ? readFileSync(join(cwd, name), "utf8") : null];
    const after = Object.fromEntries(Object.keys(files).map(read));
    return { status, lines, after };
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
    rmSync(cwd, { recursive: true, force: true });
  }
}

const testFile = (source) => ({ "src/a.test.mjs": `import { test } from "node:test";\n${source}\n` });
const step = (extra) => [{ name: "alpha", globs: ["src/*.mjs"], ...extra }];
const STALE = { ...testFile(""), [REPORT]: JSON.stringify({ numPendingTests: 0, numTodoTests: 0 }) };

const CASES = [
  ["node test passes", nodeTest, testFile("test('a', () => {})"), 0],
  ["node test is skipped", nodeTest, testFile("test.skip('a', () => {})"), 1],
  ["node test is todo", nodeTest, testFile("test.todo('a')"), 1],
  ["unit report has none", unitReport(0, 0), testFile(""), 0],
  ["unit report has a skipped test", unitReport(1, 0), testFile(""), 1],
  ["unit report has a todo test", unitReport(0, 1), testFile(""), 1],
  ["a stale unit report is not trusted", { ...unitReport(0, 0), command: node("-e", "") }, STALE, 1],
];

for (const [title, extra, files, failed] of CASES) {
  test(`a test step that reports a skipped test fails: ${title}`, () => {
    assert.equal(inFolder(files, step(extra)).status, failed);
  });
}

const NO_DOCKER = [
  ["the path is empty", { PATH: "", Path: "" }],
  ["the docker host is unreachable", { DOCKER_HOST: "tcp://127.0.0.1:1" }],
];

for (const [title, variables] of NO_DOCKER) {
  test(`a container step fails instead of skipping when docker cannot run: ${title}`, () => {
    const saved = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
    Object.assign(process.env, variables);
    try {
      const { status, lines } = inFolder(testFile(""), step({ docker: true, command: node("-e", "") }));
      assert.equal(status, 1);
      assert.ok(lines.join("\n").includes("Docker is not running"));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

test("a placeholder step reports it to the job output and prints its reason in words", () => {
  const options = (cwd) => ({
    placeholders: ["alpha"],
    reasons: { alpha: "nothing to test yet" },
    outputFile: join(cwd, "out"),
  });
  const { status, lines, after } = inFolder({ out: "" }, step({ command: node("-e", "") }), options);
  assert.equal(status, 0);
  assert.match(after.out, /^placeholder=true$/m);
  assert.ok(lines.includes("-- alpha: not applicable yet: nothing to test yet"));
});
