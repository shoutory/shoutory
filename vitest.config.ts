import { defineConfig } from "vitest/config";

// One runner per extension: .ts files run here, .mjs contract tests run only through `node --test`.
const exclude = ["**/node_modules/**", "**/dist/**", "**/*.test.mjs"];
const unit = ["{apps,packages}/*/src/**/*.test.ts", "packages/providers/*/src/**/*.test.ts"];

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: unit, exclude } },
      {
        test: { name: "unit-chatham", include: unit, exclude, pool: "forks", env: { TZ: "Pacific/Chatham" } },
      },
      {
        test: {
          name: "integration",
          // The migrated template database is built once; hooks that clone it get a longer limit than a test.
          globalSetup: ["packages/db/test/global-setup.ts"],
          hookTimeout: 30_000,
          include: [
            "{apps,packages}/*/test/integration/**/*.test.ts",
            "packages/providers/*/test/integration/**/*.test.ts",
          ],
          exclude,
        },
      },
      {
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
