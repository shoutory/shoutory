import { readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { FOUNDER_STATE } from "./support/journey";
import { APP_ORIGIN } from "./support/stack";
import { VISUAL_SNAPSHOT_PATH } from "./support/visual";

const A11Y = "a11y.spec.ts";
const QUALITY = [A11Y, ...["reflow", "focus", "recovery-download"].map((name) => `${name}.spec.ts`)];
const UX = "ux-acceptance.spec.ts";
const VISUAL = "rtl-visual.spec.ts";
// The restore drill ends with the database restored under the stack, so only a run that asks for it has the project,
// and that run has no other.
const RESTORE = "restore-drill.spec.ts";
const RESTORE_RUN = process.env.SHOUTORY_E2E_RESTORE === "true";
// Each project sends its own client address (the stack's compose overlay trusts the Docker gateway to say so), so the
// per-address limits of sign-up and sign-in count a project's people apart from every other project's.
const from = (n: number) => ({ extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${n}` } });
const JOURNEY = { name: "journey", testMatch: "onboarding.spec.ts", use: from(1) };
// Screenshots differ between platforms, so baselines are made and compared on Linux only. A listing runs nothing, so it
// may show the visual cells on any machine for the contract tests.
const LINUX = process.platform === "linux" || process.argv.includes("--list");

// A worker loads this file again with arguments of its own, so only the runner checks the command line.
const selectsRestore = process.argv.some(
  (word, at) => word === "--project=restore" || (word === "--project" && process.argv[at + 1] === "restore"),
);
if (RESTORE_RUN && !process.env.TEST_WORKER_INDEX && !selectsRestore) {
  throw new Error("SHOUTORY_E2E_RESTORE=true runs only the restore drill: add --project restore");
}

// The first journey creates the founder, since sign-up closes after the first administrator; every other spec runs
// after it, as that founder, one at a time because they share the stack.
const FULL = [
  JOURNEY,
  {
    name: "founder",
    testIgnore: ["onboarding.spec.ts", "no-telemetry.spec.ts", UX, VISUAL, RESTORE, ...QUALITY],
    dependencies: ["journey"],
    use: { storageState: FOUNDER_STATE, ...from(2) },
  },
  // The accessibility spec is its own project, the longest of the quality checks, so a shard can hold it alone.
  {
    name: "a11y",
    testMatch: A11Y,
    // The founder project's keyboard spec makes the member this spec opens the challenge screen with.
    dependencies: ["founder"],
    use: { storageState: FOUNDER_STATE, ...from(3) },
  },
  {
    name: "quality",
    testMatch: QUALITY.filter((file) => file !== A11Y),
    dependencies: ["founder", "a11y"],
    use: { storageState: FOUNDER_STATE, ...from(4) },
  },
  // Before the UX checks, which change the workspace's members.
  ...(LINUX
    ? [
        {
          name: "visual-en",
          testMatch: VISUAL,
          grep: /\(\d+ px, en, /,
          snapshotPathTemplate: VISUAL_SNAPSHOT_PATH,
          dependencies: ["quality", "a11y"],
          use: { storageState: FOUNDER_STATE, ...from(5) },
        },
        {
          name: "visual-ar",
          testMatch: VISUAL,
          grep: /\(\d+ px, ar, /,
          snapshotPathTemplate: VISUAL_SNAPSHOT_PATH,
          dependencies: ["quality", "a11y", "visual-en"],
          use: { storageState: FOUNDER_STATE, ...from(6) },
        },
      ]
    : []),
  // Its last test makes the first journey's member leave the founder's workspace, so nothing that needs that member runs
  // after it.
  {
    name: "ux",
    testMatch: UX,
    dependencies: ["quality", "a11y", ...(LINUX ? ["visual-en", "visual-ar"] : [])],
    use: { storageState: FOUNDER_STATE, ...from(7) },
  },
  // Last, so the lookups it reads cover the start-up and every spec above, whatever the files are called.
  {
    name: "telemetry",
    testMatch: "no-telemetry.spec.ts",
    dependencies: ["founder", "quality", "a11y", "ux"],
    use: { storageState: FOUNDER_STATE, ...from(8) },
  },
];

const SHARDS = JSON.parse(readFileSync(new URL("./shards.json", import.meta.url), "utf8")) as Record<
  string,
  string[]
>;
function shardOf(projects: typeof FULL, shard: string | undefined): typeof FULL {
  if (!shard) return projects;
  const chosen = SHARDS[shard];
  if (!chosen) {
    throw new Error(`SHOUTORY_E2E_SHARD must be one of ${Object.keys(SHARDS).join(", ")}, not "${shard}"`);
  }
  const names = new Set([JOURNEY.name, "founder", ...chosen]);
  return projects
    .filter((project) => names.has(project.name))
    .map((project) => {
      if (!("dependencies" in project)) return project;
      const kept = project.dependencies.filter((name) => names.has(name));
      // A project that lost a dependency still runs after the founder project, whose specs make the state it needs.
      const dependencies =
        kept.length < project.dependencies.length ? [...new Set([...kept, "founder"])] : kept;
      return { ...project, dependencies };
    });
}

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  // On CI a shard stops after ten failures: enough to show the pattern, and a red run ends in minutes.
  maxFailures: process.env.CI ? 10 : 0,
  reporter: [["list"]],
  updateSnapshots: process.env.SHOUTORY_E2E_UPDATE_VISUAL === "true" ? "all" : "missing",
  use: {
    baseURL: APP_ORIGIN,
    // A trace holds cookies and typed values: it stays on the runner and is never uploaded as a CI artifact.
    trace: "retain-on-failure",
  },
  projects: RESTORE_RUN
    ? [JOURNEY, { name: "restore", testMatch: RESTORE, dependencies: ["journey"] }]
    : shardOf(FULL, process.env.SHOUTORY_E2E_SHARD),
});
