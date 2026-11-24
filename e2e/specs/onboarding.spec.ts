import { expect, test } from "@playwright/test";
import {
  confirmEmail,
  createOrganization,
  enrolTotp,
  newAccount,
  saveFounder,
  signIn,
  signInWithCode,
  signUp,
  workspaceIdOf,
} from "../support/journey";
import { waitForLink } from "../support/mail";

test("the onboarding journey: sign up, confirm by mail, enrol TOTP, sign in with a code, create a workspace, invite, the member accepts and sees it", async ({
  page,
  browser,
}) => {
  const founder = newAccount("founder");
  await signUp(page, founder);
  await confirmEmail(page, await waitForLink({ to: founder.email, path: "/auth/verify" }));
  await signIn(page, founder);

  const workspace = await createOrganization(page, {
    organization: `Agency ${founder.tag}`,
    workspace: `Client ${founder.tag}`,
  });
  const secret = await enrolTotp(page, founder);

  await page.context().clearCookies();
  await signInWithCode(page, founder, secret);
  await expect(page.getByTestId("workspace-name")).toHaveText(workspace.name);
  const id = workspaceIdOf(page.url());

  await page.goto(`/w/${id}/settings/members`);
  const member = newAccount("member");
  await page.getByTestId("invite-open").click();
  await page.getByTestId("invite-email").fill(member.email);
  await page.getByTestId("invite-submit").click();
  await expect(page.getByTestId("invite-email")).toBeHidden();

  // The invited address can sign up although sign-up closed with the first administrator.
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const guestPage = await guest.newPage();
  await signUp(guestPage, member);
  await confirmEmail(guestPage, await waitForLink({ to: member.email, path: "/auth/verify" }));
  await signIn(guestPage, member);
  await guestPage.goto(await waitForLink({ to: member.email, path: "/invite/" }));
  await guestPage.getByTestId("invite-accept").click();
  await expect(guestPage.getByTestId("workspace-name")).toHaveText(workspace.name);
  await guest.close();

  await saveFounder(page, { account: founder, secret, workspace: { id, name: workspace.name }, member });
});
