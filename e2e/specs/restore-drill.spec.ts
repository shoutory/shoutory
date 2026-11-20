import { expect, test } from "@playwright/test";
import { loadFounder, signInWithCode, workspaceIdOf } from "../support/journey";
import {
  databaseFacts,
  dumpAndLoseTheVolume,
  plantUnsentLink,
  restoreTheDump,
  secretsCheck,
  startApp,
  waitForFreshCode,
} from "../support/restore";

// The drill of the backup guide, run on the stack the first journey made: take the dump, lose the database volume,
// restore, and prove the instance is the same one. It ends with the data changed under the stack, so it never runs
// with the other specs: only the `restore` project runs it, and only when SHOUTORY_E2E_RESTORE is true.
// A step starts or rebuilds containers and waits for their health (up to the stack's own 300 s), so the test time is
// that wait and a margin, not the 30 s of a page check.
test.describe.configure({ mode: "serial", timeout: 420_000 });

test("after a restore the app role without tenant context sees no row and holds no BYPASSRLS, and the counts of workspaces, members and forced tables equal those before the dump", async () => {
  const { account } = await loadFounder();
  const before = databaseFacts();
  // A comparison of empty with empty proves nothing, so the instance must hold what the restore has to bring back.
  expect(before.workspaces, "workspaces before the dump").toBeGreaterThan(0);
  expect(before.members, "members before the dump").toBeGreaterThan(0);
  expect(before.forced, "tables with row security forced before the dump").toBeGreaterThan(0);
  // A mail link that was never sent, sealed under the saved key: the one row `secrets check` can read.
  await plantUnsentLink(account.email);

  dumpAndLoseTheVolume();
  restoreTheDump();

  // Read as the superuser while the app is down: the same rows came back, and row security came back with them.
  const after = databaseFacts();
  expect(after.workspaces, "workspaces after the restore").toBe(before.workspaces);
  expect(after.members, "members after the restore").toBe(before.members);
  expect(after.forced, "tables with row security forced").toBe(before.forced);
  expect(after.enabledNotForced, "tables with row security enabled but not forced").toBe(0);
  expect(after.bypassRls, "the app role bypasses row security").toBe(false);
  expect(after.visibleRows, "rows the app role sees without a tenant").toBe(0);
});

test("secrets check exits 0 with the saved key ring and 1 with `not loaded: k1` when the ring lacks the saved key id", () => {
  const saved = secretsCheck("saved");
  expect(saved.status, saved.stderr).toBe(0);
  const lacking = secretsCheck("without-the-saved-id");
  expect(lacking.status).toBe(1);
  expect(lacking.stderr).toContain("not loaded: k1");
});

test("restore drill: the founder signs in with password and code after dump, volume loss and restore, sees the workspace and the accepted member, and sign-up stays closed", async ({
  browser,
}) => {
  const { account, secret, workspace, member } = await loadFounder();
  startApp();
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await waitForFreshCode();
    await signInWithCode(page, account, secret);
    await expect(page.getByTestId("workspace-name")).toHaveText(workspace.name);
    expect(workspaceIdOf(page.url())).toBe(workspace.id);
    await page.goto(`/w/${workspace.id}/settings/members`);
    await expect(page.locator("tr", { hasText: member.name })).toBeVisible();

    // The first administrator exists again, so sign-up is closed as it was.
    await page.context().clearCookies();
    await page.goto("/sign-up");
    await expect(page.getByText(/invitation-only/)).toBeVisible();
  } finally {
    await context.close();
  }
});
