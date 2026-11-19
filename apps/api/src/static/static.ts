import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { ConfigError } from "@shoutory/core/config";
import type { Context } from "hono";
import { z } from "zod";
import { Refusal } from "../errors/refusal.js";
import { type App, type AppEnv, defineRoute } from "../routes/define-route.js";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};
const IMMUTABLE = "public, max-age=31536000, immutable";
// The shell is the page the emailed links open (their token sits in the fragment): it is never stored.
const SHELL_CACHE = "no-store";
const cacheOf = (file: string): string => (basename(file) === "index.html" ? SHELL_CACHE : "no-cache");
// Hashed build assets are the only immutable files; the shell must be revalidated so a release is seen.
const ASSET_DIR = "assets";
const API_PREFIX = "api";

/** The decoded path segments, or null when the path could leave the root (`..`, backslash, NUL, bad encoding). */
function segmentsOf(url: string): string[] | null {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
  // A colon names an NTFS alternate data stream (`index.html::$DATA`) or a drive on Windows; no build file has one.
  if (path.includes("\0") || path.includes("\\") || path.includes(":")) return null;
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? null : segments;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

async function serve(file: string, cache: string): Promise<Response> {
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  return new Response(await readFile(file), { headers: { "Content-Type": type, "Cache-Control": cache } });
}

/** The request's path segments and the file they name under `base`; a path that is not ours to serve is refused. */
function locate(base: string, url: string): { segments: string[]; file: string } {
  const segments = segmentsOf(url);
  if (!segments) throw new Refusal("validation_failed", "the path is not allowed");
  // The api prefix is checked before any file lookup: no file of the build folder answers under it.
  if (segments[0] === API_PREFIX) throw new Refusal("not_found", "no such file");
  const file = resolve(join(base, ...segments));
  if (file !== base && !file.startsWith(base + sep))
    throw new Refusal("validation_failed", "outside the root");
  return { segments, file };
}

/**
 * Our own static handler for the SPA build (Hono's serveStatic is banned): a file under `root`, else the shell for a
 * client-side route. A missing asset, an API path or a path with a file extension is a 404, never the shell.
 */
function handler(root: string, shell: string | undefined) {
  const base = resolve(root);
  const indexFile = join(base, "index.html");
  // The shell given at registration is the copy read at start; it is served for the page and for `/index.html`.
  const shellResponse = async () =>
    shell === undefined
      ? serve(indexFile, SHELL_CACHE)
      : new Response(shell, {
          headers: { "Content-Type": TYPES[".html"] ?? "", "Cache-Control": SHELL_CACHE },
        });
  return async ({ c }: { c: Context<AppEnv> }): Promise<Response> => {
    const { segments, file } = locate(base, c.req.url);
    if (file === indexFile) return shellResponse();
    if (segments.length > 0 && (await isFile(file))) {
      return serve(file, segments[0] === ASSET_DIR ? IMMUTABLE : cacheOf(file));
    }
    if (segments[0] === ASSET_DIR || extname(file) !== "") throw new Refusal("not_found", "no such file");
    return shellResponse();
  };
}

/** The shell page, read once at start: it is hashed and served from this copy, never read again (R387). */
export function readShell(webRoot: string): string {
  try {
    return readFileSync(join(resolve(webRoot), "index.html"), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new ConfigError("SHOUTORY_WEB_ROOT", "SHOUTORY_WEB_ROOT holds no index.html");
    }
    throw error;
  }
}

/**
 * The CSP source of the shell's one inline script (V-76). The browser hashes the script's text after the HTML parser
 * has turned CRLF and lone CR into LF, so the same normalization is applied here. Anything but exactly one inline
 * script (a script element with no `src`) refuses the start: the page would otherwise be blocked, or an unhashed
 * script would need `unsafe-inline`.
 */
export function inlineScriptSource(html: string): string {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes]) => !/\ssrc\s*=/.test(attributes ?? ""))
    .map(([, , text]) => (text ?? "").replace(/\r\n?/g, "\n"));
  if (scripts.length !== 1) {
    throw new ConfigError(
      "SHOUTORY_WEB_ROOT",
      `SHOUTORY_WEB_ROOT index.html must hold exactly one inline script, found ${scripts.length}`,
    );
  }
  return `'sha256-${createHash("sha256")
    .update(scripts[0] ?? "", "utf8")
    .digest("base64")}'`;
}

/** `shell` is the page text read at start (`readShell`); without it the page is read from the folder per request. */
export function registerStatic(app: App, root: string, shell?: string): void {
  // The static route ignores the query (a campaign tag on the shell must not fail), so it is the one loose schema.
  defineRoute(app, {
    method: "get",
    path: "/*",
    policy: "public",
    access: "none",
    query: z.looseObject({}),
    looseQuery: true,
    handler: handler(root, shell),
  });
}
