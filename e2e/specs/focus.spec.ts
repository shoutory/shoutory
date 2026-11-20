import { expect, test } from "@playwright/test";
import { loadFounder } from "../support/journey";
import { newRecoveryCodes } from "../support/quality";

// Where a screen says focus goes, checked in a real browser: the library may drop an attribute a unit test cannot see.
// Focus moves after the page has changed, so each check waits for it instead of reading it once.
test("the palette, a dialog and a route change put focus where the screen says", async ({ page }) => {
  const { workspace } = await loadFounder();
  await page.goto(`/w/${workspace.id}`);
  await page.getByTestId("workspace-name").waitFor();

  await page.keyboard.press("ControlOrMeta+K");
  await expect(page.getByTestId("palette-search")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.goto(`/w/${workspace.id}/settings/members`);
  await page.getByTestId("invite-open").click();
  // Focus is on the dialog or on something in it.
  await expect(page.locator('[role="dialog"]:focus-within')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByTestId("invite-open")).toBeFocused();

  // A change of screen puts focus on the new screen's heading.
  await page.locator(`a[href$="/settings/general"]`).first().click();
  await expect(page.locator("h1")).toBeFocused();
});

test("new recovery codes take focus when they appear, and the security heading takes it back when saved", async ({
  page,
}) => {
  const { account } = await loadFounder();
  await newRecoveryCodes(page, account.password);
  await expect(page.getByTestId("recovery-codes").locator("h2")).toBeFocused();
  await page.getByTestId("recovery-saved").click();
  await expect(page.getByTestId("recovery-codes")).toHaveCount(0);
  await expect(page.locator("h2:focus")).toHaveCount(1);
});
