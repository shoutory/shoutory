#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function renderMatrix(manifests) {
  const lines = [
    "# Provider capability matrix",
    "",
    "Generated from the provider manifests by `scripts/gen-capability-matrix.mjs`; do not edit by hand.",
    "",
  ];
  if (manifests.length === 0) return `${[...lines, "No providers are registered yet."].join("\n")}\n`;
  lines.push("| Provider | Id | Lifecycle | Read-back | Capabilities |", "|---|---|---|---|---|");
  for (const m of [...manifests].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(
      `| ${m.displayName} | ${m.id} | ${m.lifecycle} | ${m.readBackMode} | ${m.capabilities.join(", ")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function loadManifests(argv) {
  const at = argv.indexOf("--manifests");
  if (at >= 0) return JSON.parse(readFileSync(argv[at + 1], "utf8"));
  const [registryDist, sdkDist] = [
    join(root, "packages/provider-registry/dist/index.js"),
    join(root, "packages/provider-sdk/dist/registry.js"),
  ];
  if (!existsSync(registryDist) || !existsSync(sdkDist))
    throw new Error("the provider registry's dist is missing; run `pnpm exec tsc -b` first");
  const { builtInManifests } = await import(pathToFileURL(registryDist).href);
  const { createRegistry } = await import(pathToFileURL(sdkDist).href);
  return createRegistry(builtInManifests).manifests;
}

function outPath(argv) {
  const at = argv.indexOf("--out");
  return at >= 0 ? resolve(argv[at + 1]) : join(root, "docs/providers/capability-matrix.md");
}

async function main(argv) {
  const text = renderMatrix(await loadManifests(argv));
  const file = outPath(argv);
  if (argv.includes("--check")) {
    if (existsSync(file) && readFileSync(file, "utf8") === text) return 0;
    console.error(
      `${file} is missing or stale; run \`node scripts/gen-capability-matrix.mjs\` and commit it`,
    );
    return 1;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
