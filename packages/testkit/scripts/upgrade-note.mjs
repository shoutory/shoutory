#!/usr/bin/env node
// Usage, from the repository root: node packages/testkit/scripts/upgrade-note.mjs <version or v-tag>
import { existsSync } from "node:fs";

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function upgradeNoteProblems(text, noteExists) {
  const match = VERSION.exec(text);
  if (!match) return [`${text} is not a version`];
  const [, major, minor, patch, prerelease] = match;
  if (Number(major) < 1 || minor !== "0" || patch !== "0" || prerelease) return [];
  const version = `${major}.0.0`;
  const note = `docs/upgrade/${version}.md`;
  return noteExists(note) ? [] : [`major release ${version} has no upgrade note at ${note}`];
}

if (import.meta.main) {
  const problems = upgradeNoteProblems(process.argv[2] ?? "", existsSync);
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(problems.length === 0 ? 0 : 1);
}
