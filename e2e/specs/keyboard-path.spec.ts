import { expect, type Page, test } from "@playwright/test";
import { createClient, createMember, loadFounder } from "../support/journey";
import { nextTotp } from "../support/totp";

const MAX_TABS = 20;

/** Moves focus with Tab alone until the element with this test id has it. */
async function tabTo(page: Page, id: string): Promise<void> {
  for (let presses = 0; presses <= MAX_TABS; presses += 1) {
    const active = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
    if (active === id) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`${id} is not reachable by Tab within ${MAX_TABS} presses`);
}

// The whole path is done from the keyboard; no pointer event is sent after the page opens.
test("keyboard only: sign-in, MFA, workspace switch", async ({ page, browser }) => {
  const founder = await loadFounder();
  // Neither name contains the other, so typing one name matches one workspace only.
  const second = await createClient(page, `Keyboard target ${founder.account.tag}`);
  const { account, secret } = await createMember({
    browser,
    inviter: page,
    label: "keyboard",
    workspaces: [founder.workspace, second],
  });
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const seen = await guest.newPage();
  const keys = seen.keyboard;

  await seen.goto("/sign-in");
  await tabTo(seen, "sign-in-email");
  await keys.type(account.email);
  await keys.press("Tab");
  await tabTo(seen, "sign-in-password");
  await keys.type(account.password);
  await keys.press("Enter");

  await seen.waitForURL(/\/mfa/);
  await tabTo(seen, "mfa-code");
  await keys.type(await nextTotp(secret));
  await keys.press("Enter");
  await seen.waitForURL(/\/w\//);

  // Switch to whichever of the two workspaces is not open: type its name, take the first match, confirm.
  const open = (await seen.getByTestId("workspace-name").textContent())?.trim();
  const target = open === second.name ? founder.workspace : second;
  await tabTo(seen, "switcher-workspace");
  await keys.type(target.name);
  await keys.press("ArrowDown");
  await keys.press("Enter");
  await expect(seen.getByTestId("workspace-name")).toHaveText(target.name);
  expect(seen.url()).toContain(`/w/${target.id}`);
  await guest.close();
});
