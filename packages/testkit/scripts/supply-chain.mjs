#!/usr/bin/env node
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

// A package the allowlist names (`allowedPackages`, an exact name or a prefix ending in `*`) is not judged by its licence:
// sharp's prebuilt libvips packages are LGPL, unmodified and dynamically loaded, and nothing else is.
const named = (name, patterns) =>
  patterns.some((pattern) =>
    pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  );

const EXEMPT_TOKENS = new Set(["LGPL-3.0-or-later", "Apache-2.0", "AND", "OR", "(", ")"]);
const withinExemption = (expression) =>
  (expression.match(/\(|\)|AND|OR|[^\s()]+/g) ?? []).every((token) => EXEMPT_TOKENS.has(token));

export function licenceProblems(licences, allowed, allowedPackages = []) {
  return Object.entries(licences)
    .map(([expression, found]) => [
      expression,
      withinExemption(expression) ? found.filter((p) => !named(p.name, allowedPackages)) : found,
    ])
    .filter(([expression, found]) => found.length > 0 && !allowedExpression(expression, allowed))
    .map(([expression, found]) => `licence ${expression} is not allowed: ${found.map((p) => p.name)}`);
}

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
  const { allowed, allowedPackages } = JSON.parse(
    readFileSync("packages/testkit/licence-allowlist.json", "utf8"),
  );
  const files = ["package.json", ...globSync("{apps,packages}/*/package.json")];
  files.push(...globSync("packages/providers/*/package.json"));
  const manifests = files.map((file) => ({ file, ...JSON.parse(readFileSync(file, "utf8")) }));
  const problems = [
    ...licenceProblems(pnpmLicences(), allowed, allowedPackages),
    ...lockfileChangeProblems(changedFiles()),
    ...lockProblems(readFileSync("pnpm-lock.yaml", "utf8")),
    ...exclusionProblems(readFileSync("pnpm-workspace.yaml", "utf8"), new Date().toISOString().slice(0, 10)),
    ...cardProblems(manifests, readFileSync("docs/dependencies.md", "utf8")),
  ];
  for (const problem of problems) console.error(`FAIL ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
