import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppPool } from "@shoutory/db/pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createLogger } from "../logging/logger.js";
import { defineRoute } from "../routes/define-route.js";
import { registerStatic } from "./static.js";

const SHELL = "<!doctype html><title>shell-marker-1</title>";
const SECRET = "outside-the-static-root-marker";
let root: string;
let app: ReturnType<typeof createApp>;

const newApp = () =>
  createApp({
    publicOrigin: "https://app.example.test",
    trustedProxies: [],
    pool: createAppPool("postgres://shoutory_app:app-test-secret-1@127.0.0.1:1/none", () => undefined),
    logger: createLogger({ secrets: [], stream: { write: () => undefined } }),
  });

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "shoutory-static-"));
  root = join(base, "dist");
  mkdirSync(join(root, "assets"), { recursive: true });
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
