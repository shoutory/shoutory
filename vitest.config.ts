import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

// The web components use Lingui's macros, which only the Lingui plugin compiles; it is a dependency of apps/web, so it
// is resolved from there. The web tests render components, so they need the same compilation as the build.
const webDir = join(import.meta.dirname, "apps/web");
const { lingui } = (await import(
  pathToFileURL(createRequire(join(webDir, "package.json")).resolve("@lingui/vite-plugin")).href
)) as { lingui: (options: { macroTransform: boolean; cwd: string }) => Plugin };
const linguiForWeb = () => lingui({ macroTransform: true, cwd: webDir });

// One runner per extension: .ts files run here, .mjs contract tests run only through `node --test`.
const exclude = ["**/node_modules/**", "**/dist/**", "**/*.test.mjs"];
const unit = ["{apps,packages}/*/src/**/*.test.ts", "packages/providers/*/src/**/*.test.ts"];
// The web app's tests need a DOM, so they run in their own projects; the node projects leave them out.
const web = ["apps/web/src/**/*.test.{ts,tsx}"];
const nodeExclude = [...exclude, "apps/web/**"];

// Tests read workspace packages from `src` through the `source` export condition; Node reads `dist`.
const ssr = { resolve: { conditions: ["source"], externalConditions: ["source"] } };

export default defineConfig({
  test: {
    projects: [
      { ssr, test: { name: "unit", include: unit, exclude: nodeExclude } },
      {
        ssr,
        test: {
          name: "unit-chatham",
          include: unit,
          exclude: nodeExclude,
          pool: "forks",
          env: { TZ: "Pacific/Chatham" },
        },
      },
      { plugins: [linguiForWeb()], test: { name: "web", environment: "happy-dom", include: web, exclude } },
      {
        plugins: [linguiForWeb()],
        test: {
          name: "web-chatham",
          environment: "happy-dom",
          include: web,
          exclude,
          pool: "forks",
          env: { TZ: "Pacific/Chatham" },
        },
      },
      {
        ssr,
        test: {
          name: "integration",
          // The migrated template database is built once; hooks that clone it get a longer limit than a test.
          // The second file installs the job queue's schema into that template (the db package never imports the api).
          globalSetup: ["packages/db/test/global-setup.ts", "apps/api/test/global-setup.ts"],
          // Vitest 5.0.5 hands Vite a Buffer for modules read from its cache, which crashes the printing of any
          // global-setup error (vitest-dev/vitest#11682). Remove when the pinned Vitest includes that fix.
          fsModuleCache: false,
          hookTimeout: 30_000,
          // The sign-in tests run a dozen memory-hard password hashes each, and the database container shares the host's
          // cores: with every core busy a test of 1.9 s alone took 4.5 s (a hash 90 ms alone, 200 ms loaded) and met its
          // 5 s limit. Three files at a time keep it near 2 s, for a suite about 20 s longer.
          maxWorkers: 3,
          include: [
            "{apps,packages}/*/test/integration/**/*.test.ts",
            "packages/providers/*/test/integration/**/*.test.ts",
          ],
          exclude,
        },
      },
      {
        ssr,
        test: {
          name: "contract",
          // The web bundle contract runs two full Vite builds in one hook, which the default 10 s cannot always hold.
          hookTimeout: 60_000,
          testTimeout: 30_000,
          include: [
            "{apps,packages}/*/test/contract/**/*.test.ts",
            "packages/providers/*/test/contract/**/*.test.ts",
          ],
          exclude,
        },
      },
    ],
  },
});
