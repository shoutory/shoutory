import { defineConfig } from "@playwright/test";
import { FOUNDER_STATE } from "./support/journey";
import { APP_ORIGIN } from "./support/stack";

const QUALITY = ["a11y-m0", "reflow", "focus", "recovery-download"].map((name) => `${name}.spec.ts`);
const UX = "ux-acceptance.spec.ts";
const VISUAL = "rtl-visual.spec.ts";
// Screenshots differ between platforms, so the baselines are made and compared on one: Linux, as in CI. The project
// does not exist anywhere else, and a CI run with the update input makes new baselines.
const LINUX = process.platform === "linux";

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
  // A CI run started with the update input writes every baseline; any other run compares and writes none that exist.
  updateSnapshots: process.env.SHOUTORY_E2E_UPDATE_VISUAL === "true" ? "all" : "missing",
  use: {
    baseURL: APP_ORIGIN,
    // A trace holds cookies and typed values: it stays on the runner and is never uploaded as a CI artifact.
    trace: "retain-on-failure",
  },
  projects: [
    { name: "journey", testMatch: "j1-onboarding.spec.ts" },
    {
      name: "founder",
      testIgnore: ["j1-onboarding.spec.ts", "no-telemetry.spec.ts", UX, VISUAL, ...QUALITY],
      dependencies: ["journey"],
      use: { storageState: FOUNDER_STATE },
    },
    // The screen quality checks walk the whole catalogue, as the founder or in an empty browser each spec opens.
    {
      name: "quality",
      testMatch: QUALITY,
      // After the founder project, whose keyboard spec makes the member the challenge screen is opened with.
      dependencies: ["founder"],
      use: { storageState: FOUNDER_STATE },
    },
    // Photographs of every screen; before the UX checks, which change the workspace's members.
    ...(LINUX
      ? [
          {
            name: "visual",
            testMatch: VISUAL,
            dependencies: ["quality"],
            use: { storageState: FOUNDER_STATE },
          },
        ]
      : []),
    // The UX acceptance checks come after the screen checks; its last test makes the first journey's member leave the
    // founder's workspace, so nothing runs after it that needs that member.
    {
      name: "ux",
      testMatch: UX,
      dependencies: LINUX ? ["quality", "visual"] : ["quality"],
      use: { storageState: FOUNDER_STATE },
    },
    // Last, so the lookups it reads cover the start-up and every spec above, whatever the files are called.
    {
      name: "telemetry",
      testMatch: "no-telemetry.spec.ts",
      dependencies: ["founder", "quality", "ux"],
      use: { storageState: FOUNDER_STATE },
    },
  ],
});
