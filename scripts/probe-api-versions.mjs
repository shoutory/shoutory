#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The probe only needs to know that the page answers, so the body is cancelled after `maxBytes`.
async function drain(response, maxBytes) {
  if (!response.body) return;
  const reader = response.body.getReader();
  let read = 0;
  while (read < maxBytes) {
    const { done, value } = await reader.read();
    if (done) return;
    read += value.byteLength;
  }
  await reader.cancel();
}

async function probeOne(url, { fetch: send, timeoutMs, maxBytes }) {
  if (!url.startsWith("https://")) return "the URL is not https";
  try {
    const response = await send(url, {
      method: "GET",
      headers: { accept: "text/html,application/json" },
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return `the answer was HTTP ${response.status}`;
    await drain(response, maxBytes);
    return null;
  } catch (error) {
    return `no answer (${error instanceof Error ? error.name : "error"})`;
  }
}

export async function probeApiVersions(manifests, options = {}) {
  const settings = { fetch: globalThis.fetch, timeoutMs: 10_000, maxBytes: 65_536, ...options };
  const problems = [];
  for (const manifest of manifests) {
    for (const entry of manifest.apiVersions) {
      const url = entry.probeUrl ?? entry.docsUrl;
      const reason = await probeOne(url, settings);
      if (reason) problems.push({ providerId: manifest.id, version: entry.version, url, reason });
    }
  }
  return { ok: problems.length === 0, problems };
}

async function main() {
  const [registryDist, sdkDist] = [
    join(root, "packages/provider-registry/dist/index.js"),
    join(root, "packages/provider-sdk/dist/registry.js"),
  ];
  if (!existsSync(registryDist) || !existsSync(sdkDist))
    throw new Error("the provider registry's dist is missing; run `pnpm exec tsc -b` first");
  const { builtInManifests } = await import(pathToFileURL(registryDist).href);
  const { createRegistry } = await import(pathToFileURL(sdkDist).href);
  const { ok, problems } = await probeApiVersions(createRegistry(builtInManifests).manifests);
  for (const p of problems) console.error(`${p.providerId} ${p.version}: ${p.url}: ${p.reason}`);
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
