import { expect, test } from "@playwright/test";
import { loadFounder, loadMember, memberStatePath, signInWithCode } from "../support/journey";
import { inPage, newRecoveryCodes } from "../support/quality";
import { waitForFreshCode } from "../support/restore";

// A real browser, because the library may drop an attribute a unit test cannot see. Focus moves after the page has
// changed, so each check waits for it instead of reading it once.
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
  await expect(page.locator('[role="dialog"]:focus-within')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByTestId("invite-open")).toBeFocused();

  await page.locator(`a[href$="/settings/general"]`).first().click();
  await expect(page.locator("h1")).toBeFocused();
});

// A member of its own, not the founder: the server takes a code once per person (one per ninety seconds) and ten checks
// per person every fifteen minutes, and every other spec that uses the founder spends those. This member's codes are
// used only here and at enrolment, and the sign-in with a code makes the session's identity check fresh, so no second
// code is spent.
test("new recovery codes take focus when they appear, and the security heading takes it back when saved", async ({
  browser,
}) => {
  const { account, secret } = loadMember("keyboard");
  await waitForFreshCode(memberStatePath("keyboard"));
  await inPage(browser, { audience: "signed-out", locale: "en", theme: "light" }, async (page) => {
    await signInWithCode(page, account, secret);
    await newRecoveryCodes(page, account.password, secret, false);
    await expect(page.getByTestId("recovery-codes").locator("h2")).toBeFocused();
    await page.getByTestId("recovery-saved").click();
    await expect(page.getByTestId("recovery-codes")).toHaveCount(0);
    await expect(page.locator("h2:focus")).toHaveCount(1);
  });
});
