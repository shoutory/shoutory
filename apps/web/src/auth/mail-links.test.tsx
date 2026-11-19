import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchRoutes } from "react-router";
import { describe, expect, it } from "vitest";
import { routes } from "../routes";

// The api mails links to web pages (`pageLink` in apps/api/src/auth/auth.ts). Each path must be a page of this app, or
// the link opens "Page not found".
const source = readFileSync(join(import.meta.dirname, "../../../api/src/auth/auth.ts"), "utf8");
const MAILED = [...new Set([...source.matchAll(/pageLink\(\s*"([^"]+)"/g)].map((found) => found[1] ?? ""))];

describe("the links the api mails", () => {
  it("the scan finds the three mailed pages", () => {
    expect([...MAILED].sort()).toEqual(["/auth/reset", "/auth/sign-in", "/auth/verify"]);
  });

  it.each(MAILED)("%s is a page of this app", (path) => {
    const leaf = matchRoutes(routes, path)?.at(-1)?.route.path;
    expect(leaf).toBeDefined();
    expect(leaf).not.toBe("*");
  });
});
