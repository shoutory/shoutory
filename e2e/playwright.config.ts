import { defineConfig } from "@playwright/test";

// Specs live in e2e/specs, helpers in e2e/support, data and simulators in e2e/fixtures.
export default defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.SHOUTORY_E2E_BASE_URL ?? "http://localhost:8080",
    trace: "retain-on-failure",
  },
});
