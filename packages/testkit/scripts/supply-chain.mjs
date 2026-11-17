#!/usr/bin/env node
// Supply-chain checks, run from the repository root: licences, lockfile changes and resolutions,
// release-age exclusions, and an evaluation card for every runtime dependency.
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { parseAllDocuments, parseDocument } from "yaml";

// `pnpm licenses list --json` keys packages by licence expression. An OR passes when any operand is
// allowed, an AND only when all are, and anything else fails: Unknown, a leftover token, an unclosed
// parenthesis and an exception clause (WITH) alike, since there is no exception allowlist.
function allowedExpression(expression, allowed) {
  const tokens = expression.match(/\(|\)|AND|OR|[^\s()]+/g) ?? [];
  let at = 0;
  let valid = true;
  const atom = () => {
    if (tokens[at] !== "(") return allowed.includes(tokens[at++]);
    at++;
    const value = either();
    if (tokens[at++] !== ")") valid = false;
    return value;
  };
  const both = () => {
    let value = atom();
    while (tokens[at] === "AND") {
      at++;
      value = atom() && value;
    }
    return value;
  };
  const either = () => {
    let value = both();
    while (tokens[at] === "OR") {
      at++;
      value = both() || value;
    }
    return value;
  };
  const result = either();
  return valid && at === tokens.length && result;
}

export function licenceProblems(licences, allowed) {
  return Object.entries(licences)
    .filter(([expression]) => !allowedExpression(expression, allowed))
    .map(([expression, found]) => `licence ${expression} is not allowed: ${found.map((p) => p.name)}`);
}

// A lockfile change needs a workspace manifest or the workspace settings changed beside it.
const WORKSPACE_MANIFESTS = [
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^(apps|packages)\/[^/]+\/package\.json$/,
  /^packages\/providers\/[^/]+\/package\.json$/,
];
export function lockfileChangeProblems(changed) {
  const manifest = changed.some((file) => WORKSPACE_MANIFESTS.some((pattern) => pattern.test(file)));
  return changed.includes("pnpm-lock.yaml") && !manifest
    ? ["pnpm-lock.yaml changed without a manifest or workspace settings change"]
    : [];
}

// In a lockfile a registry package carries only an integrity; a tarball URL or a source type means another host.
export function resolutionProblems(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([, { resolution = {} }]) => "tarball" in resolution || "type" in resolution)
    .map(([id]) => `${id} resolves from outside the registry`);
}

// Every release-age exclusion carries `until YYYY-MM-DD` in its comment and is removed once that day has passed.
export function exclusionProblems(workspaceText, today) {
  const list = parseDocument(workspaceText).get("minimumReleaseAgeExclude", true);
  return (list?.items ?? []).flatMap((item) => {
    const name = String(item.value ?? item);
    const until = item.comment?.match(/\buntil (\d{4}-\d{2}-\d{2})/)?.[1];
    if (!until) return [`exclusion has no "until" date: ${name}`];
    return until < today ? [`exclusion expired on ${until}: ${name}`] : [];
  });
}

export function cardProblems(manifests, cardsText) {
  const cards = new Set([...cardsText.matchAll(/^## (\S+)/gm)].map((match) => match[1]));
  return manifests.flatMap(({ file, dependencies = {} }) =>
    // A workspace package is our own code, not a third-party dependency, so it has no card.
    Object.entries(dependencies)
      .filter(([name, range]) => !cards.has(name) && !String(range).startsWith("workspace:"))
      .map(([name]) => name)
      .map((name) => `${file}: runtime dependency ${name} has no card in docs/dependencies.md`),
  );
}

function pnpmLicences() {
  const exe = process.env.npm_execpath ?? "pnpm";
  const [bin, ...args] = /\.c?js$/.test(exe)
    ? [process.execPath, exe, "licenses", "list", "--json"]
    : [exe, "licenses", "list", "--json"];
  return JSON.parse(execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}

// pnpm 12 writes the lockfile as several YAML documents (its own tooling first, then the project).
export const lockProblems = (text) =>
  parseAllDocuments(text)
    .map((document) => document.toJS() ?? {})
    .flatMap(resolutionProblems);

function changedFiles() {
  const base = process.env.SUPPLY_CHAIN_BASE ?? "HEAD~1";
  return execFileSync("git", ["diff", "--name-only", base], { encoding: "utf8" }).split("\n").filter(Boolean);
}

function main() {
  const allowed = JSON.parse(readFileSync("packages/testkit/licence-allowlist.json", "utf8")).allowed;
  const files = ["package.json", ...globSync("{apps,packages}/*/package.json")];
  files.push(...globSync("packages/providers/*/package.json"));
  const manifests = files.map((file) => ({ file, ...JSON.parse(readFileSync(file, "utf8")) }));
  const problems = [
    ...licenceProblems(pnpmLicences(), allowed),
    ...lockfileChangeProblems(changedFiles()),
    ...lockProblems(readFileSync("pnpm-lock.yaml", "utf8")),
    ...exclusionProblems(readFileSync("pnpm-workspace.yaml", "utf8"), new Date().toISOString().slice(0, 10)),
    ...cardProblems(manifests, readFileSync("docs/dependencies.md", "utf8")),
  ];
  for (const problem of problems) console.error(`FAIL ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
