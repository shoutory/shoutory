import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."), ".github/workflows");

// Rules every workflow follows; id-token: write is only for release.yml jobs that run on tags in the
// protected release environment.
function stepProblems(id, step) {
  const inputs = step.with ?? {};
  const problems = [];
  if (step.uses?.startsWith("actions/checkout@") && inputs["persist-credentials"] !== false) {
    problems.push(`${id}: checkout must set persist-credentials: false`);
  }
  if (step.uses?.startsWith("actions/setup-node@") && inputs["package-manager-cache"] !== false) {
    problems.push(`${id}: setup-node must set package-manager-cache: false`);
  }
  if ("cache" in inputs || inputs["package-manager-cache"] === true) problems.push(`${id}: no cache`);
  return problems;
}

function ruleProblems(file, workflow) {
  const problems = [];
  if (JSON.stringify(workflow.permissions) !== "{}") problems.push("top-level permissions must be {}");
  for (const [id, job] of Object.entries(workflow.jobs)) {
    problems.push(...(job.steps ?? []).flatMap((step) => stepProblems(id, step)));
    const oidc = job.permissions?.["id-token"] === "write";
    const gated =
      file === "release.yml" && job.environment === "release" && /refs\/tags\//.test(job.if ?? "");
    if (oidc && !gated) problems.push(`${id}: id-token: write outside a release tag job`);
  }
  return problems;
}

const job = (extra) => ({ jobs: { a: { steps: [], ...extra } }, permissions: {} });
const checkout = (inputs) => ({ steps: [{ uses: "actions/checkout@x", with: inputs }] });
const FIXTURES = [
  ["a workflow without top-level permissions fails", "x.yml", { jobs: { a: {} } }, 1],
  ["a checkout that keeps credentials fails", "x.yml", job(checkout({})), 1],
  ["a checkout that drops credentials passes", "x.yml", job(checkout({ "persist-credentials": false })), 0],
  [
    "a setup-node step that leaves the package cache implicit fails",
    "x.yml",
    job({ steps: [{ uses: "actions/setup-node@x" }] }),
    1,
  ],
  ["a cache input fails", "x.yml", job({ steps: [{ uses: "a/b@x", with: { cache: "pnpm" } }] }), 1],
  ["id-token in an ordinary workflow fails", "x.yml", job({ permissions: { "id-token": "write" } }), 1],
  [
    "id-token in a release job without tag gating fails",
    "release.yml",
    job({ permissions: { "id-token": "write" } }),
    1,
  ],
  [
    "id-token in a release tag job in the release environment passes",
    "release.yml",
    job({
      permissions: { "id-token": "write" },
      environment: "release",
      if: "startsWith(github.ref, 'refs/tags/v')",
    }),
    0,
  ],
];

for (const [title, file, workflow, expected] of FIXTURES) {
  test(`workflow rules: ${title}`, () => {
    assert.equal(ruleProblems(file, workflow).length, expected);
  });
}

test("workflow rules: every workflow in the repository follows them", () => {
  const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.deepEqual(ruleProblems(file, parse(readFileSync(join(dir, file), "utf8"))), [], file);
  }
});
