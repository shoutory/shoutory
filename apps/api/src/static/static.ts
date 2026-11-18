import { readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
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

/**
 * Our own static handler for the SPA build (Hono's serveStatic is banned): a file under `root`, else the shell for a
 * client-side route. A missing asset, an API path or a path with a file extension is a 404, never the shell.
 */
function handler(root: string) {
  const base = resolve(root);
  return async ({ c }: { c: Context<AppEnv> }): Promise<Response> => {
    const segments = segmentsOf(c.req.url);
    if (!segments) throw new Refusal("validation_failed", "the path is not allowed");
    const file = resolve(join(base, ...segments));
    if (file !== base && !file.startsWith(base + sep))
      throw new Refusal("validation_failed", "outside the root");
    if (segments.length > 0 && (await isFile(file))) {
      return serve(file, segments[0] === ASSET_DIR ? IMMUTABLE : cacheOf(file));
    }
    const isAsset = segments[0] === ASSET_DIR;
    const isApi = segments[0] === "api";
    if (isAsset || isApi || extname(file) !== "") throw new Refusal("not_found", "no such file");
    return serve(join(base, "index.html"), SHELL_CACHE);
  };
}

export function registerStatic(app: App, root: string): void {
  // The static route ignores the query (a campaign tag on the shell must not fail), so it is the one loose schema.
  defineRoute(app, {
    method: "get",
    path: "/*",
    policy: "public",
    access: "none",
    query: z.looseObject({}),
    looseQuery: true,
    handler: handler(root),
  });
}
