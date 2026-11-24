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
  { name: "milestone prefix in a file name", regex: new RegExp(["(?:^|[/\\s])m", "\\d+-[a-z]"].join("")) },
  { name: "milestone suffix in a file name", regex: new RegExp(["-m", "\\d+\\.[a-z]"].join("")) },
  { name: "milestone folder", regex: new RegExp(["\\bperf/m", "\\d+/"].join("")) },
  { name: "journey id in a file name", regex: new RegExp(["(?:^|/)j", "\\d+-"].join("")) },
];

// Citations of planning documents and their ids: ruling ids, rule numbers, verification ids, requirement ids, open
// questions and the architecture and UX documents. Product words stay free: `flows` only counts with a section number.
export const CITATION_PATTERNS = [
  { name: "ruling id", regex: new RegExp(["\\bR", "\\d{3}\\b"].join("")) },
  { name: "rule number", regex: new RegExp(["\\bAGENTS", " \\d"].join("")) },
  { name: "ledger spec row", regex: new RegExp(["\\bO", "L \\d"].join("")) },
  { name: "verification id", regex: new RegExp(["\\bV", "-\\d+\\b"].join("")) },
  {
    name: "requirement id",
    regex: new RegExp(
      ["\\b(?:NFR|FLAG|COMPL|OPS|LAUNCH|REL|PLT|VIS|INV|DATA)", "-(?:[A-Z]+-)?\\d+\\b"].join(""),
    ),
  },
  { name: "requirement id", regex: new RegExp(["\\bF", "-[A-Z]+-\\d+\\b"].join("")) },
  { name: "security case id", regex: new RegExp(["\\bSSR", "F-\\d+\\b"].join("")) },
  { name: "walkthrough id", regex: new RegExp(["\\bWI", "-F\\d+\\b"].join("")) },
  { name: "case id", regex: new RegExp(["\\bBG", "-\\d+\\b"].join("")) },
  { name: "case id", regex: new RegExp(["\\bE", "-\\d+\\b"].join("")) },
  { name: "security set name", regex: new RegExp(["\\bH", "3\\b"].join("")) },
  { name: "ledger spec term", regex: new RegExp(["\\bO", "L transition"].join("")) },
  { name: "policy template name", regex: new RegExp(["\\btemplate ", "[WODU]\\b"].join("")) },
  { name: "provider class name", regex: new RegExp(["\\bclass ", "[A-E]\\b"].join("")) },
  { name: "spike id", regex: new RegExp(["\\bSP", "-\\d+\\b"].join("")) },
  { name: "milestone token", regex: new RegExp(["\\bM", "\\d+[a-z]?\\b(?! ?\\d)"].join("")) },
  { name: "journey id", regex: new RegExp(["\\bJ", "\\d+\\b"].join("")) },
  { name: "planning document", regex: new RegExp(["data", " model"].join("")) },
  { name: "open question id", regex: new RegExp(["\\bQ", "-[A-Z]+\\d*\\b"].join("")) },
  { name: "planning document", regex: new RegExp(["\\bflows? ", "\\d+(?:\\.\\d+)?"].join("")) },
  { name: "planning document", regex: new RegExp(["data", "-model"].join("")) },
  { name: "planning document", regex: new RegExp(["ux", "-spec"].join("")) },
];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

// A tracked path that is deleted or not readable in this checkout has no text to scan; any other error is a defect.
const UNREADABLE = new Set(["ENOENT", "EACCES", "EPERM"]);

function readText(file) {
  try {
    const buffer = readFileSync(file);
    return buffer.includes(0) ? null : buffer.toString("utf8");
  } catch (error) {
    if (UNREADABLE.has(error?.code)) return null;
    throw error;
  }
}

function scanLine(label, line, lineNumber, patterns, findings) {
  for (const { name, regex } of patterns) {
    if (regex.test(line)) findings.push(`${label}:${lineNumber}: ${name} (${regex.source})`);
  }
}

export function scan() {
  const findings = [];
  for (const file of trackedFiles()) {
    if (EXCLUDED_FILES.has(file)) continue;
    scanLine(file, file, 0, PATTERNS, findings);
    const text = readText(file);
    if (text === null) continue;
    for (const [index, line] of text.split(/\r?\n/).entries())
      scanLine(file, line, index + 1, [...PATTERNS, ...CITATION_PATTERNS], findings);
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
