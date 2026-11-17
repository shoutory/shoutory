#!/usr/bin/env node
// Fails when a tracked file of this repository mentions a planning-workspace artefact.
// Scans tracked file paths and tracked text contents (git ls-files) of the current directory's repository.
// Pattern fragments are joined at run time so this table never matches itself.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EXCLUDED_FILES = new Set([
  "scripts/check-no-planning-paths.mjs",
  "scripts/check-no-planning-paths.test.mjs",
  ".gitignore",
]);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const PATTERNS = [
  { name: "planning path", regex: new RegExp(["PLAN", ".md"].map(escapeRegex).join("")) },
  { name: "planning path", regex: new RegExp(["docs", "[/\\\\]", "plans"].join("")) },
  { name: "planning path", regex: new RegExp(["docs", "[/\\\\]", "prd"].join("")) },
  { name: "planning path", regex: new RegExp(["docs", "[/\\\\]", "tasks"].join("")) },
  { name: "planning path", regex: new RegExp(["DECISIONS", "\\.md"].join("")) },
  { name: "planning path", regex: new RegExp(["OWNER", "-QUESTIONS"].join("")) },
  { name: "planning path", regex: new RegExp(["PROGRESS", "\\.md"].join("")) },
  { name: "planning path", regex: new RegExp(["NUMBERING", "-MAP"].join("")) },
  { name: "workspace root path", regex: new RegExp(["shoutory", "-main"].join(""), "i") },
  { name: "workspace root path", regex: new RegExp(["E:", "[/\\\\]{1,2}", "saas"].join(""), "i") },
  { name: "ADR number", regex: new RegExp(["\\bAD", "R-\\d+"].join("")) },
  { name: "slice id", regex: new RegExp(["\\bM", "\\d+[a-z]?", "-\\d{2}\\b"].join("")) },
  { name: "plan label", regex: new RegExp(["\\bOD", "-M"].join("")) },
  { name: "plan label", regex: new RegExp(["\\bA", "-M\\d+-"].join("")) },
];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

function readText(file) {
  try {
    const buffer = readFileSync(file);
    return buffer.includes(0) ? null : buffer.toString("utf8");
  } catch {
    return null;
  }
}

function scanLine(label, line, lineNumber, findings) {
  for (const { name, regex } of PATTERNS) {
    if (regex.test(line)) findings.push(`${label}:${lineNumber}: ${name} (${regex.source})`);
  }
}

export function scan() {
  const findings = [];
  for (const file of trackedFiles()) {
    if (EXCLUDED_FILES.has(file)) continue;
    scanLine(file, file, 0, findings);
    const text = readText(file);
    if (text === null) continue;
    for (const [index, line] of text.split(/\r?\n/).entries()) scanLine(file, line, index + 1, findings);
  }
  return findings;
}

function main() {
  const findings = scan();
  if (findings.length === 0) {
    console.log("check-no-planning-paths: clean");
    return 0;
  }
  for (const finding of findings) console.error(finding);
  console.error(`check-no-planning-paths: ${findings.length} finding(s)`);
  return 1;
}

process.exit(main());
