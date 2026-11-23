import { defineConfig } from "vitest/config";

// The scheduled mutation run (stryker.config.mjs) executes only the unit tests of the modules it mutates: the root
// config also holds the integration project, which needs the database, and Stryker cannot select a project.
export default defineConfig({
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    include: [
      "packages/core/src/authz/**/*.test.ts",
      "packages/core/src/counting/**/*.test.ts",
      "packages/core/src/ledger/client.test.ts",
      "packages/provider-sdk/src/snapshot.test.ts",
    ],
  },
});
