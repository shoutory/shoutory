import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runSteps, STEPS } from "../../../../scripts/verify.mjs";

const step = STEPS.find((candidate) => candidate.name === "commit-message");

function lint(title) {
  const before = process.env.PR_TITLE;
  process.env.PR_TITLE = title;
  try {
    return runSteps([step], { placeholders: [], log: () => undefined });
  } finally {
    if (before === undefined) delete process.env.PR_TITLE;
    else process.env.PR_TITLE = before;
  }
}

const TITLES = [
  ["a conventional title passes", "feat(ci): add the supply-chain check", 0],
  ["a breaking change marker passes", "fix(api)!: drop the legacy route", 0],
  ["a title with no type fails", "add the supply-chain check", 1],
  ["a title with an unknown type fails", "wip: add the supply-chain check", 1],
  ["a title with a capitalised subject fails", "feat: Add the supply-chain check", 1],
];

for (const [title, input, status] of TITLES) {
  test(`the commit-message step: ${title}`, () => {
    assert.equal(lint(input), status);
  });
}
