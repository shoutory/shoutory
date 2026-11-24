import { randomUUID } from "node:crypto";
import { type APIResponse, expect, test } from "@playwright/test";
import { confirmEmail, createClient, loadFounder, newAccount, signIn, signUp } from "../support/journey";
import { waitForLink } from "../support/mail";

test("an outsider with an account sees no trace of the workspace: not in the list, /w/<id> shows not-found, its members API answers not-found", async ({
  page,
  browser,
}) => {
  const founder = await loadFounder();
  const other = await createClient(page, `Other client ${founder.account.tag}`);
  await page.goto(`/w/${other.id}/settings/members`);
  const outsider = newAccount("outsider");
  await page.getByTestId("invite-open").click();
  await page.getByTestId("invite-email").fill(outsider.email);
  // An admin, so the outsider's own members list is one the server answers (a viewer would be refused it).
  await page.getByTestId("invite-role").click();
  await page.getByTestId("invite-role-admin").click();
  await page.getByTestId("invite-submit").click();
  await expect(page.getByTestId("invite-email")).toBeHidden();

  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const seen = await guest.newPage();
  await signUp(seen, outsider);
  await confirmEmail(seen, await waitForLink({ to: outsider.email, path: "/auth/verify" }));
  await signIn(seen, outsider);
  await seen.goto(await waitForLink({ to: outsider.email, path: "/invite/" }));
  await seen.getByTestId("invite-accept").click();
  await expect(seen.getByTestId("workspace-name")).toHaveText(other.name);

  const mine = await seen.request.get("/api/v1/workspaces");
  const listed = JSON.stringify(await mine.json());
  expect(listed).toContain(other.name);
  expect(listed).not.toContain(founder.workspace.id);
  expect(listed).not.toContain(founder.workspace.name);

  await seen.goto(`/w/${founder.workspace.id}`);
  await expect(seen.getByTestId("not-found")).toBeVisible();
  await expect(seen.getByTestId("workspace-name")).toHaveCount(0);

  const own = await seen.request.get(`/api/v1/workspaces/${other.id}/members`);
  expect(own.status()).toBe(200);
  const refused = await refusalOf(
    await seen.request.get(`/api/v1/workspaces/${founder.workspace.id}/members`),
  );
  const unknown = await refusalOf(await seen.request.get(`/api/v1/workspaces/${randomUUID()}/members`));
  expect(refused.status).toBe(404);
  expect(refused).toEqual(unknown);
  await guest.close();
});

async function refusalOf(answer: APIResponse): Promise<{ status: number; code: unknown }> {
  const body = (await answer.json()) as { error?: { code?: unknown }; code?: unknown };
  return { status: answer.status(), code: body.error?.code ?? body.code };
}
