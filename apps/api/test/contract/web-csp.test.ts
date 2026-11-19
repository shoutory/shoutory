import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

async function scriptSrcServedFrom(webRoot: string): Promise<string> {
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
  return csp.split(";").find((part) => part.trim().startsWith("script-src")) ?? "";
}

describe("the policy served with the built web page", () => {
  it("allows the built inline script by the hash a real parser computes, and nothing else inline", async () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    const scripts = await parsedInlineScripts(html);
    expect(scripts).toHaveLength(1);
    const scriptSrc = await scriptSrcServedFrom(out);
    expect(scriptSrc).toContain(hashOf(scripts[0] ?? ""));
    expect(scriptSrc).not.toContain("unsafe-inline");
  });
});
