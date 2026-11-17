import { strict as assert } from "node:assert";
import { test } from "node:test";
import { judge } from "../../../../scripts/ci-aggregate.mjs";

const done = (result, placeholder) => ({ result, outputs: { placeholder } });

const CASES = [
  ["every job succeeded", { a: done("success", ""), b: done("success", "") }, ["b"], 0],
  ["a job failed", { a: done("success", ""), b: done("failure", "") }, [], 1],
  ["a job was skipped", { a: done("skipped", "") }, [], 1],
  ["a job was cancelled", { a: done("cancelled", "") }, [], 1],
  ["a listed placeholder reported", { a: done("success", "true") }, ["a"], 0],
  ["a job not listed reported a placeholder", { a: done("success", "true") }, ["b"], 1],
];

for (const [title, needs, listed, problems] of CASES) {
  test(`the aggregate judges: ${title}`, () => {
    assert.equal(judge(needs, listed).length, problems);
  });
}
