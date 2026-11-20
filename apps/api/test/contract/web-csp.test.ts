import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/logging/logger.js";
import { testAuth } from "../support/auth.js";

// The real web build, not a fixture: the policy must allow the script the build really emits (V-76, R360).
const webPackage = join(import.meta.dirname, "../../../web/package.json");
const fromWeb = createRequire(webPackage);
const out = mkdtempSync(join(tmpdir(), "web-csp-build-"));

beforeAll(() => {
  const bin = join(dirname(fromWeb.resolve("vite/package.json")), "bin/vite.js");
  execFileSync(process.execPath, [bin, "build", "--outDir", out, "--emptyOutDir", "--logLevel", "silent"], {
    cwd: dirname(webPackage),
    stdio: "pipe",
  });
}, 60_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

// The expected hash comes from a real HTML parser (happy-dom, a dependency of apps/web, loaded like Vite), not from
// the pattern the code under test uses: the text of each script element without `src`, as the parser delivers it.
const { Window } = fromWeb("happy-dom") as {
  Window: new (options: {
    settings: { disableJavaScriptEvaluation: boolean };
  }) => {
    document: {
      write: (html: string) => void;
      querySelectorAll: (selector: string) => Iterable<{
        hasAttribute: (name: string) => boolean;
        textContent: string | null;
      }>;
    };
    close: () => Promise<void>;
  };
};

// happy-dom keeps a CR as written (it skips the HTML Standard's input-stream preprocessing), so it cannot prove the
// CRLF rule; that rule is held by the unit row of static.test.ts, and this parser proves the built page.
async function parsedInlineScripts(html: string): Promise<string[]> {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true } });
  window.document.write(html);
  const scripts = [...window.document.querySelectorAll("script")]
    .filter((script) => !script.hasAttribute("src"))
    .map((script) => script.textContent ?? "");
  await window.close();
  return scripts;
}

const hashOf = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

async function directiveServedFrom(webRoot: string, directive: string): Promise<string> {
  const publicOrigin = "https://app.example.test";
  const pool = createAppPool("postgres://shoutory_app:app-test-secret-1@127.0.0.1:1/none", () => undefined);
  const keys = new EnvKeyProvider({
    SHOUTORY_ACTIVE_KEY_ID: "k1",
    SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
  });
  const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
  const app = createApp({
    publicOrigin,
    trustedProxies: [],
    pool,
    keys,
    logger,
    auth: testAuth(pool, keys, logger, publicOrigin),
    webRoot,
  });
  const response = await app.request("/", {}, { incoming: { socket: { remoteAddress: "192.0.2.1" } } });
  const csp = response.headers.get("content-security-policy") ?? "";
  return csp.split(";").find((part) => part.trim().startsWith(directive)) ?? "";
}

// React Aria inserts two `<style>` elements with fixed text when a control is pressed or an overlay opens. The policy
// allows them by hash, so the expected hash comes from the installed package's own files: an upgrade that changes a
// text fails here before it ships, instead of being refused in the browser.
function injectedStyleTexts(): string[] {
  // `react-aria` is a dependency of `react-aria-components`, so it sits beside it in the package store.
  const racDir = realpathSync(join(dirname(webPackage), "node_modules/react-aria-components"));
  const source = (file: string) =>
    readFileSync(join(dirname(racDir), "react-aria/dist/private", file), "utf8");
  const text = (code: string) => /style\.textContent = `([\s\S]*?)`\.trim\(\)/.exec(code)?.[1] ?? "";
  const press = source("interactions/usePress.mjs");
  const attribute = /PRESSABLE_ATTRIBUTE = '([^']+)'/.exec(press)?.[1] ?? "";
  return [
    text(press)
      .replace(/\$\{[^}]*PRESSABLE_ATTRIBUTE\}/, attribute)
      .trim(),
    text(source("overlays/usePreventScroll.mjs")).trim(),
  ];
}

describe("the policy served with the built web page", () => {
  it("allows the built inline script by the hash a real parser computes, and nothing else inline", async () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    const scripts = await parsedInlineScripts(html);
    expect(scripts).toHaveLength(1);
    const scriptSrc = await directiveServedFrom(out, "script-src");
    expect(scriptSrc).toContain(hashOf(scripts[0] ?? ""));
    expect(scriptSrc).not.toContain("unsafe-inline");
  });

  it("allows the two style elements React Aria inserts by their hash, and no other inline style", async () => {
    const texts = injectedStyleTexts();
    expect(texts.every((text) => text.startsWith("@layer {"))).toBe(true);
    const styleSrc = await directiveServedFrom(out, "style-src");
    for (const text of texts) expect(styleSrc).toContain(hashOf(text));
    expect(styleSrc).toContain("'self'");
    expect(styleSrc).not.toContain("unsafe-inline");
    expect(styleSrc).not.toContain("nonce-");
  });
});
