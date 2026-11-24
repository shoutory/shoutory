export default {
  // pnpm keeps the runner outside the core package's own folder, where Stryker looks for plugins by default.
  plugins: ["@stryker-mutator/vitest-runner"],
  tempDirName: ".artifacts/stryker-tmp",
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts" },
  mutate: [
    "packages/core/src/authz/*.ts",
    "packages/core/src/counting/*.ts",
    "packages/core/src/ledger/client.ts",
    "packages/provider-sdk/src/snapshot.ts",
    "!**/*.test.ts",
  ],
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: ".artifacts/mutation/report.json" },
  // The sandbox copy rewrites tsconfig files through the TypeScript JavaScript API, which the pinned native compiler
  // (TypeScript 7) does not have. The job runs on a clean checkout, and Stryker restores every file it mutates.
  inPlace: true,
};
