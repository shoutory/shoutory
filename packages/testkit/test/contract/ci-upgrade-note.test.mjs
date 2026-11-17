import { strict as assert } from "node:assert";
import { test } from "node:test";
import { upgradeNoteProblems } from "../../scripts/upgrade-note.mjs";

const CASES = [
  ["a major version without its note fails", "2.0.0", false, 1],
  ["a major version with its note passes", "2.0.0", true, 0],
  ["a tag name with the v prefix is judged like the version", "v1.0.0", false, 1],
  ["a minor version passes", "1.1.0", false, 0],
  ["a patch version passes", "1.0.1", false, 0],
  ["a 0.x version passes", "0.5.0", false, 0],
  ["a prerelease of a major passes", "2.0.0-beta.1", false, 0],
  ["a text that is not a version fails", "next", true, 1],
];

for (const [title, version, noteExists, problems] of CASES) {
  test(`upgrade note: ${title}`, () => {
    assert.equal(upgradeNoteProblems(version, () => noteExists).length, problems);
  });
}
