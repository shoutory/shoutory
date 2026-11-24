#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function judge(needs, listed) {
  const problems = Object.keys(needs).length === 0 ? ["no job result was given"] : [];
  for (const [job, { result, outputs }] of Object.entries(needs)) {
    if (result !== "success") problems.push(`${job}: ${result}`);
    else if (outputs?.placeholder === "true" && !listed.includes(job)) {
      problems.push(`${job}: reported a placeholder but is not in the placeholder list`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const file = join(root, ".github/ci-placeholders.json");
  const listed = JSON.parse(readFileSync(file, "utf8")).map((entry) => entry.name);
  const problems = judge(JSON.parse(process.env.NEEDS), listed);
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(problems.length === 0 ? 0 : 1);
}
