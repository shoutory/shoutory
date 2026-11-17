import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ruleset = JSON.parse(readFileSync(join(root, ".github/rulesets/main.json"), "utf8"));
const rule = (type) => ruleset.rules.find((candidate) => candidate.type === type);

test("the ruleset requires neither code-owner review nor signed commits", () => {
  assert.equal(rule("required_signatures"), undefined);
  const review = rule("pull_request").parameters;
  assert.equal(review.require_code_owner_review, false);
  assert.equal(review.required_approving_review_count, 0);
  assert.deepEqual(review.allowed_merge_methods, ["squash"]);
  const checks = rule("required_status_checks").parameters.required_status_checks;
  assert.deepEqual(checks.map((check) => check.context).sort(), ["ci", "license/cla"]);
  for (const type of ["required_linear_history", "non_fast_forward", "deletion"]) assert.ok(rule(type), type);
  assert.deepEqual(
    ruleset.bypass_actors.map((actor) => actor.actor_id),
    [5],
  );
});
