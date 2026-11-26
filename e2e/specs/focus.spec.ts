import { expect, type Page, test } from "@playwright/test";
import { loadFounder, loadMember, memberStatePath, signInWithCode } from "../support/journey";
import { inPage, newRecoveryCodes, openScreen } from "../support/quality";
import { waitForFreshCode } from "../support/restore";
import { SCREENS } from "../support/screens";

// A real browser, because the library may drop an attribute a unit test cannot see. Focus moves after the page has
// changed, so each check waits for it instead of reading it once.
test("the palette, dialogs and a route change put focus where the screen says", async ({ page }) => {
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

  // The menu that opens the shortcuts list closes as the list opens, so focus goes back to the Account button.
  await page.getByTestId("account-menu").click();
  await page.getByTestId("shortcuts-open").press("Enter");
  await expect(page.locator('[role="dialog"]:focus-within')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByTestId("account-menu")).toBeFocused();

  await page.locator(`a[href$="/settings/general"]`).first().click();
  await expect(page.locator("h1")).toBeFocused();
});

async function tabTo(page: Page, id: string, key = "Tab"): Promise<void> {
  for (let presses = 0; presses <= 30; presses += 1) {
    const active = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
    if (active === id) return;
    await page.keyboard.press(key);
  }
  throw new Error(`${id} is not reachable by ${key}`);
}

test("several media files are selected and deleted with the keyboard alone", async ({ browser }) => {
  const screen = SCREENS.find((entry) => entry.id === "media");
  if (!screen) throw new Error("no media screen");
  await inPage(browser, { audience: "founder", locale: "en", theme: "light" }, async (page) => {
    await openScreen(page, screen, browser);
    const keys = page.keyboard;
    await tabTo(page, "media-tile");
    await keys.press("Space");
    await keys.press("ControlOrMeta+A");
    await expect(page.locator('[data-testid="media-tile"][aria-selected="true"]')).toHaveCount(3);
    await tabTo(page, "media-bulk-delete", "Shift+Tab");
    await keys.press("Enter");
    await expect(page.getByTestId("bulk-delete-cancel")).toBeFocused();
    await tabTo(page, "bulk-delete-confirm");
    await keys.press("Enter");
    await expect(page.getByTestId("media-heading")).toBeFocused();
    await expect(page.getByTestId("media-tile")).toHaveCount(0);
  });
});

test("a media file is renamed and deleted with the keyboard alone", async ({ browser }) => {
  const screen = SCREENS.find((entry) => entry.id === "media-detail");
  if (!screen) throw new Error("no media-detail screen");
  await inPage(browser, { audience: "founder", locale: "en", theme: "light" }, async (page) => {
    await openScreen(page, screen, browser);
    const keys = page.keyboard;
    await tabTo(page, "detail-edit");
    await keys.press("Enter");
    await tabTo(page, "edit-name");
    await keys.press("ControlOrMeta+A");
    await keys.type("renamed.png");
    await tabTo(page, "edit-save");
    await keys.press("Enter");
    await expect(page.getByTestId("detail-name")).toHaveText("renamed.png");
    await expect(page.getByTestId("detail-edit")).toBeFocused();

    await tabTo(page, "detail-delete");
    await keys.press("Enter");
    await expect(page.getByTestId("delete-cancel")).toBeFocused();
    await tabTo(page, "delete-confirm");
    await keys.press("Enter");
    await expect(page.getByTestId("not-found")).toBeVisible();
    await expect(page.getByTestId("media-detail-back")).toBeFocused();
  });
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
