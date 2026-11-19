import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testAuth } from "../../test/support/auth.js";
import { createApp } from "../app.js";
import { createLogger } from "../logging/logger.js";
import { defineRoute } from "../routes/define-route.js";
import { registerStatic } from "./static.js";

const SHELL = "<!doctype html><title>shell-marker-1</title>";
const SECRET = "outside-the-static-root-marker";
let root: string;
let app: ReturnType<typeof createApp>;

const newApp = (extra: { webRoot?: string } = {}) => {
  const publicOrigin = "https://app.example.test";
  const pool = createAppPool("postgres://shoutory_app:app-test-secret-1@127.0.0.1:1/none", () => undefined);
  const keys = new EnvKeyProvider({
    SHOUTORY_ACTIVE_KEY_ID: "k1",
    SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
  });
  const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
  return createApp({
    publicOrigin,
    trustedProxies: [],
    pool,
    keys,
    logger,
    auth: testAuth(pool, keys, logger, publicOrigin),
    ...extra,
  });
};

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "shoutory-static-"));
  root = join(base, "dist");
  mkdirSync(join(root, "assets"), { recursive: true });
  // A file under api/ exists in the build folder; the api prefix is never a static path (R387).
  mkdirSync(join(root, "api"));
  writeFileSync(join(root, "api", "inside.txt"), SECRET);
  writeFileSync(join(root, "index.html"), SHELL);
  writeFileSync(join(root, "assets", "app-abc123.js"), "export const marker = 1;");
  writeFileSync(join(base, "secret.txt"), SECRET);
  app = newApp();
  registerStatic(app, root);
});

afterAll(() => rmSync(join(root, ".."), { recursive: true, force: true }));

const get = (path: string) =>
  Promise.resolve(app.request(path, {}, { incoming: { socket: { remoteAddress: "192.0.2.1" } } }));

describe("static handler", () => {
  it.each(["/", "/calendar/2026-11", "/settings"])(
    "serves the SPA shell for %s with the CSP and security headers",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(SHELL);
      const csp = response.headers.get("content-security-policy") ?? "";
      for (const directive of [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ]) {
        expect(csp).toContain(directive);
      }
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toMatch(/no-cache|no-store/);
    },
  );

  it.each(["/auth/verify", "/auth/reset", "/"])(
    "the shell for the page %s is never stored and sends no referrer",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    },
  );

  it("caches a fingerprinted asset as immutable", async () => {
    const response = await get("/assets/app-abc123.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toContain("javascript");
  });
});

describe("static handler paths", () => {
  it("lists no directory and serves no file that is missing", async () => {
    const directory = await get("/assets/");
    expect(directory.status).toBe(404);
    expect(await directory.text()).not.toContain("app-abc123.js");
    expect((await get("/assets/missing.js")).status).toBe(404);
  });

  it.each([
    // The URL parser folds dot segments into the root, so the file is simply missing there (404).
    ["/../secret.txt", 404],
    ["/assets/../../secret.txt", 404],
    ["/%2e%2e/secret.txt", 404],
    ["/assets/%2e%2e/%2e%2e/secret.txt", 404],
    ["//secret.txt", 404],
    // An encoded separator survives the parser; the handler refuses a decoded path with `..`, `\` or NUL.
    ["/..%2fsecret.txt", 400],
    ["/assets/..%5c..%5csecret.txt", 400],
    ["/assets/app-abc123.js%00.txt", 400],
    // A colon names an NTFS alternate data stream on Windows: `index.html::$DATA` would read the file itself.
    ["/index.html::$DATA", 400],
    // The api prefix is checked before any file lookup: a file of that name inside the root is not served.
    ["/api/inside.txt", 404],
  ])("never serves a file outside the root for %s (status %i)", async (path, status) => {
    const response = await get(path);
    expect(await response.text()).not.toContain(SECRET);
    expect(response.status).toBe(status);
  });

  it("answers an API path that does not exist with the 404 envelope, never the SPA shell", async () => {
    const response = await get("/api/v1/nothing");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});

describe("static route ordering", () => {
  it("a GET route added after app creation is not shadowed by the shell when the static route is registered last", async () => {
    const late = newApp();
    defineRoute(late, {
      method: "get",
      path: "/test/late",
      policy: "public",
      access: "none",
      handler: () => ({ late: true }),
    });
    registerStatic(late, root);
    const response = await late.request(
      "/test/late",
      {},
      { incoming: { socket: { remoteAddress: "192.0.2.1" } } },
    );
    expect(await response.json()).toEqual({ data: { late: true } });
  });
});

// V-76: the page's one inline script is allowed by its hash, never by `unsafe-inline`.
const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const MODULE = '<script type="module" src="/assets/main-abc123.js"></script>';
const shellWith = (...inline: string[]) =>
  `<!doctype html><head>${inline.map((text) => `<script>${text}</script>`).join("")}${MODULE}</head>`;

function webRootWith(html: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "shoutory-webroot-"));
  if (html !== null) writeFileSync(join(dir, "index.html"), html);
  return dir;
}

const scriptSrcOf = async (webRoot: string) => {
  const response = await newApp({ webRoot }).request(
    "/",
    {},
    { incoming: { socket: { remoteAddress: "192.0.2.1" } } },
  );
  expect(response.status).toBe(200);
  const csp = response.headers.get("content-security-policy") ?? "";
  return csp.split(";").find((part) => part.trim().startsWith("script-src")) ?? "";
};

describe("the served CSP and the inline script (V-76)", () => {
  it.each([
    ["a one-line script", "window.a=1;"],
    ["comments, CRLF (hashed as LF) and surrounding newlines", "\n  // theme\r\n  window.a=1;\n"],
    ["non-ASCII text", "window.a='العربية';"],
  ])("the script-src carries the hash of the exact script bytes: %s", async (_name, script) => {
    const scriptSrc = await scriptSrcOf(webRootWith(shellWith(script)));
    // The HTML parser turns CRLF into LF before the browser hashes the text, so the expected hash does the same.
    expect(scriptSrc).toContain(sha256(script.replace(/\r\n?/g, "\n")));
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("a changed script gets the new hash and the old one is gone", async () => {
    const before = await scriptSrcOf(webRootWith(shellWith("window.a=1;")));
    const after = await scriptSrcOf(webRootWith(shellWith("window.a=2;")));
    expect(after).toContain(sha256("window.a=2;"));
    expect(after).not.toContain(sha256("window.a=1;"));
    expect(before).toContain(sha256("window.a=1;"));
  });

  it.each([
    ["no inline script", webRootWith(shellWith())],
    ["two inline scripts", webRootWith(shellWith("window.a=1;", "window.b=2;"))],
    ["no index.html", webRootWith(null)],
  ])("refuses to start with %s and names the variable", (_name, webRoot) => {
    expect(() => newApp({ webRoot })).toThrow(/SHOUTORY_WEB_ROOT/);
  });

  // R387: the shell is read once at start; a build replaced under the running process is never served with a hash
  // that no longer matches it.
  it.each(["/", "/index.html", "/calendar"])("serves the shell read at start for %s", async (path) => {
    const webRoot = webRootWith(shellWith("window.a=1;"));
    const app = newApp({ webRoot });
    writeFileSync(join(webRoot, "index.html"), shellWith("window.a=2;"));
    const response = await app.request(path, {}, { incoming: { socket: { remoteAddress: "192.0.2.1" } } });
    expect(await response.text()).toContain("window.a=1;");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(sha256("window.a=1;"));
  });

  it("unset webRoot registers no static route: a page path is the 404 envelope", async () => {
    const response = await newApp().request(
      "/calendar",
      {},
      { incoming: { socket: { remoteAddress: "192.0.2.1" } } },
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});
