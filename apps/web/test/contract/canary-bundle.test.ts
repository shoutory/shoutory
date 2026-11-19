import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type InlineConfig } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const webRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const CANARY = 'web-canary"v\\1/a b+c=d';

// The canary as it can appear in a file: encoded whole, or inside base64 text at any of the three byte alignments
// (the first characters of an offset encoding also hold the bytes before it, and the last group holds the bytes after).
const base64At = (offset: number) => {
  const text = Buffer.from("x".repeat(offset) + CANARY).toString("base64");
  return text.slice([0, 2, 3][offset], -4);
};
const SPELLINGS: Record<string, string> = {
  raw: CANARY,
  "percent-encoded": encodeURIComponent(CANARY),
  hex: Buffer.from(CANARY).toString("hex"),
  "hex upper-case": Buffer.from(CANARY).toString("hex").toUpperCase(),
  base64: Buffer.from(CANARY).toString("base64"),
  "base64 at offset 1": base64At(1),
  "base64 at offset 2": base64At(2),
  "JSON-escaped": JSON.stringify(CANARY).slice(1, -1),
  // A bundler writes a value into a template literal with only its backslashes escaped.
  "backslash-escaped": CANARY.replaceAll("\\", "\\\\"),
};

// Every file under `dir` is read as bytes (fonts and images included) and searched for every spelling.
function scan(dir: string) {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  const hits = files.flatMap((entry) => {
    const bytes = readFileSync(join(entry.parentPath, entry.name));
    return Object.entries(SPELLINGS)
      .filter(([, spelling]) => bytes.includes(spelling))
      .map(([form]) => `${entry.name}: ${form}`);
  });
  return { files: files.map((entry) => entry.name), hits };
}

// The text of every script element that has no `src` attribute.
function inlineScripts(html: string) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes]) => !/\ssrc\s*=/.test(attributes ?? ""))
    .map(([, , text]) => text ?? "");
}

const fixtures = mkdtempSync(join(tmpdir(), "web-bundle-fixture-"));
// An extra entry that reads the server's secret the two ways a mistake would, so a leak has somewhere to land.
const planted = join(fixtures, "planted.js");
writeFileSync(
  planted,
  "export const a = process.env.SHOUTORY_CANARY;\nexport const b = import.meta.env.SHOUTORY_CANARY;\n",
);

// The real web build config plus the planted entry; `extra` is how a test changes the config to prove the check.
async function buildWeb(outDir: string, extra: InlineConfig = {}) {
  await build({
    root: webRoot,
    configFile: join(webRoot, "vite.config.ts"),
    logLevel: "silent",
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: { input: { main: join(webRoot, "index.html"), planted } },
    },
    ...extra,
  });
}

// The mistake the check must catch: a config that copies server environment values into the code. A fixed object
// stands in for the environment, so the proof never writes the real one to disk.
const LEAK: InlineConfig = { define: { "process.env": { SHOUTORY_CANARY: CANARY } } };

describe("the built client bundle", () => {
  const out = mkdtempSync(join(tmpdir(), "web-bundle-"));
  const leaky = mkdtempSync(join(tmpdir(), "web-bundle-leak-"));

  beforeAll(async () => {
    // Variables without the VITE_ prefix are the server's secrets: the build must never read them into the bundle.
    vi.stubEnv("SHOUTORY_CANARY", CANARY);
    await buildWeb(out);
    await buildWeb(leaky, LEAK);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    for (const dir of [out, leaky, fixtures]) rmSync(dir, { recursive: true, force: true });
  });

  it("a planted canary never appears in the built client bundle", () => {
    const { files, hits } = scan(out);
    expect(files).toContain("index.html");
    expect(files.some((name) => name.endsWith(".js"))).toBe(true);
    expect(hits).toEqual([]);
  });

  it("the check fails when the build config copies the environment into the code", () => {
    expect(scan(leaky).hits.length >= 1).toBe(true);
  });

  it.each(Object.entries(SPELLINGS))("the scan finds the canary in a fixture file, %s", (form, spelling) => {
    const dir = join(fixtures, form.replaceAll(" ", "-"));
    mkdirSync(dir);
    writeFileSync(join(dir, "chunk.js"), `export const leaked = "${spelling}";`);
    expect(scan(dir).hits).toContain(`chunk.js: ${form}`);
  });

  it("the built page holds exactly one inline script, the theme bootstrap", () => {
    const scripts = inlineScripts(readFileSync(join(out, "index.html"), "utf8"));
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.trim()).toBe(readFileSync(join(webRoot, "src/theme/bootstrap.js"), "utf8").trim());
  });

  it("the inline-script count sees a second inline script and ignores a script with a src", () => {
    const page = '<script src="/a.js"></script><script>a()</script><script type="module">b()</script>';
    expect(inlineScripts(page)).toEqual(["a()", "b()"]);
  });
});
