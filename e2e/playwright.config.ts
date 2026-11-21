import { readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { FOUNDER_STATE } from "./support/journey";
import { APP_ORIGIN } from "./support/stack";
import { VISUAL_SNAPSHOT_PATH } from "./support/visual";

const A11Y = "a11y-m0.spec.ts";
const QUALITY = [A11Y, ...["reflow", "focus", "recovery-download"].map((name) => `${name}.spec.ts`)];
const UX = "ux-acceptance.spec.ts";
const VISUAL = "rtl-visual.spec.ts";
// The restore drill ends with the database restored under the stack, so only a run that asks for it (the weekly job,
// or `SHOUTORY_E2E_RESTORE=true pnpm e2e --project restore`) has the project, and that run has no other.
const RESTORE = "restore-drill.spec.ts";
const RESTORE_RUN = process.env.SHOUTORY_E2E_RESTORE === "true";
const JOURNEY = { name: "journey", testMatch: "j1-onboarding.spec.ts" };
// Screenshots differ between platforms, so the baselines are made and compared on one: Linux, as in CI. The project
// does not exist anywhere else (except in a listing, which runs nothing and writes no picture, so the contract tests
// can see the visual cells on any machine), and a CI run with the update input makes new baselines.
const LINUX = process.platform === "linux" || process.argv.includes("--list");

// The switch is set for the restore project alone. The runner reads the command line; a worker loads this file again
// with arguments of its own and must not check them.
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
    testIgnore: ["j1-onboarding.spec.ts", "no-telemetry.spec.ts", UX, VISUAL, RESTORE, ...QUALITY],
    dependencies: ["journey"],
    use: { storageState: FOUNDER_STATE },
  },
  // The screen quality checks walk the whole catalogue, as the founder or in an empty browser each spec opens. The
  // accessibility spec is its own project, the longest of them, so a shard can hold it alone.
  {
    name: "a11y",
    testMatch: A11Y,
    // After the founder project, whose keyboard spec makes the member the challenge screen is opened with.
    dependencies: ["founder"],
    use: { storageState: FOUNDER_STATE },
  },
  {
    name: "quality",
    testMatch: QUALITY.filter((file) => file !== A11Y),
    dependencies: ["founder", "a11y"],
    use: { storageState: FOUNDER_STATE },
  },
  // Photographs of every screen, one project per language (the cell's title names it); before the UX checks, which
  // change the workspace's members.
  ...(LINUX
    ? [
        {
          name: "visual-en",
          testMatch: VISUAL,
          grep: /\(\d+ px, en, /,
          snapshotPathTemplate: VISUAL_SNAPSHOT_PATH,
          dependencies: ["quality", "a11y"],
          use: { storageState: FOUNDER_STATE },
        },
        {
          name: "visual-ar",
          testMatch: VISUAL,
          grep: /\(\d+ px, ar, /,
          snapshotPathTemplate: VISUAL_SNAPSHOT_PATH,
          dependencies: ["quality", "a11y", "visual-en"],
          use: { storageState: FOUNDER_STATE },
        },
      ]
    : []),
  // The UX acceptance checks come after the screen checks; its last test makes the first journey's member leave the
  // founder's workspace, so nothing runs after it that needs that member.
  {
    name: "ux",
    testMatch: UX,
    dependencies: ["quality", "a11y", ...(LINUX ? ["visual-en", "visual-ar"] : [])],
    use: { storageState: FOUNDER_STATE },
  },
  // Last, so the lookups it reads cover the start-up and every spec above, whatever the files are called.
  {
    name: "telemetry",
    testMatch: "no-telemetry.spec.ts",
    dependencies: ["founder", "quality", "a11y", "ux"],
    use: { storageState: FOUNDER_STATE },
  },
];

// A CI job runs one shard: the first journey and the founder project (the state every spec needs) plus the projects the
// table in shards.json names. Without the variable every project runs, as on a developer's machine.
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

// Specs live in e2e/specs, helpers in e2e/support, data and simulators in e2e/fixtures. One stack serves the whole run
// (global setup).
export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  // On CI a shard stops after ten failed tests: enough to show the pattern, and a red run ends in minutes. A local run,
  // often one test being reproduced, has no limit.
  maxFailures: process.env.CI ? 10 : 0,
  reporter: [["list"]],
  // A CI run started with the update input writes every baseline; any other run compares and writes none that exist.
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
