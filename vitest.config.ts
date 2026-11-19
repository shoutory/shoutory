import { defineConfig } from "vitest/config";

// One runner per extension: .ts files run here, .mjs contract tests run only through `node --test`.
const exclude = ["**/node_modules/**", "**/dist/**", "**/*.test.mjs"];
const unit = ["{apps,packages}/*/src/**/*.test.ts", "packages/providers/*/src/**/*.test.ts"];

// Tests read workspace packages from `src` through the `source` export condition; Node reads `dist`.
const ssr = { resolve: { conditions: ["source"], externalConditions: ["source"] } };

export default defineConfig({
  test: {
    projects: [
      { ssr, test: { name: "unit", include: unit, exclude } },
      {
        ssr,
        test: { name: "unit-chatham", include: unit, exclude, pool: "forks", env: { TZ: "Pacific/Chatham" } },
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
