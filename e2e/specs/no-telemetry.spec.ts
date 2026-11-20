import { expect, test } from "@playwright/test";
import { loadFounder } from "../support/journey";
import { APP_ORIGIN, lookedUpNames } from "../support/stack";

// The breach check is the one documented outside call: its range lookup carries five hex characters of a hash.
const BREACH_CHECK = "api.pwnedpasswords.com";

test("a fresh install makes no outbound telemetry call: the DNS sidecar saw only the breach check, the browser only the app origin", async ({
  page,
}) => {
  const origins = new Set<string>();
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) origins.add(new URL(request.url()).origin);
  });
  const { workspace } = await loadFounder();
  for (const path of [
    `/w/${workspace.id}`,
    `/w/${workspace.id}/settings/members`,
    "/account/security",
    "/admin/releases",
    "/admin/flags",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect([...origins]).toEqual([APP_ORIGIN]);

  // Every name the app looked up outside the stack since it started, which includes the whole first journey. The
  // breach check must appear, or a dead sidecar would pass this row.
  const names = lookedUpNames();
  expect(names).toContain(BREACH_CHECK);
  expect(names.filter((name) => name !== BREACH_CHECK)).toEqual([]);
});
