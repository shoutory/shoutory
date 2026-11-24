import { defineConfig } from "vitest/config";

// The root config also holds the integration project, which needs the database, and Stryker cannot select a project.
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
