import { defineConfig } from "@playwright/test";
import { FOUNDER_STATE } from "./support/journey";
import { APP_ORIGIN } from "./support/stack";

// Specs live in e2e/specs, helpers in e2e/support, data and simulators in e2e/fixtures. One stack serves the whole run
// (global setup). The first journey creates the founder, since sign-up closes after the first administrator; every
// other spec runs after it, as that founder, one at a time because they share the stack.
export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: APP_ORIGIN,
    // A trace holds cookies and typed values: it stays on the runner and is never uploaded as a CI artifact.
    trace: "retain-on-failure",
  },
  projects: [
    { name: "journey", testMatch: "j1-onboarding.spec.ts" },
    {
      name: "founder",
      testIgnore: ["j1-onboarding.spec.ts", "no-telemetry.spec.ts"],
      dependencies: ["journey"],
      use: { storageState: FOUNDER_STATE },
    },
    // Last, so the lookups it reads cover the start-up and every spec above, whatever the files are called.
    {
      name: "telemetry",
      testMatch: "no-telemetry.spec.ts",
      dependencies: ["founder"],
      use: { storageState: FOUNDER_STATE },
    },
  ],
});
