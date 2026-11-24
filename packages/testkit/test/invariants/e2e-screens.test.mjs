import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CATALOGUE = "e2e/support/screens.ts";

const full = (path) => (path === "*" || path.startsWith("/") ? path : `/${path}`);

test("every route path of the app is a screen of the e2e catalogue or an exempt route with a reason", async () => {
  assert.ok(existsSync(join(root, CATALOGUE)), `there is no ${CATALOGUE}`);
  const { SCREENS, EXEMPT } = await import(pathToFileURL(join(root, CATALOGUE)).href);
  const routes = readFileSync(join(root, "apps/web/src/routes.tsx"), "utf8");
  const paths = [...routes.matchAll(/\bpath: "([^"]+)"/g)].map(([, path]) => path);
  assert.ok(paths.length >= 20, "the routes file was not read");
  // A nested route (an admin page) is written as its last segment, so it matches a catalogue path that ends with it.
  const known = (path) =>
    SCREENS.some((screen) => screen.pattern === full(path) || screen.pattern.endsWith(`/${path}`));
  const missing = paths.filter((path) => !known(path) && !(path in EXEMPT));
  assert.deepEqual(missing, [], "routes with no catalogue screen");
  for (const [path, reason] of Object.entries(EXEMPT)) {
    assert.ok(paths.includes(path), `exempt path ${path} is not a route`);
    assert.ok(String(reason).length >= 10, `exempt path ${path} has no reason`);
  }
});
