import { expect, type Page, test } from "@playwright/test";
import { loadFounder, signIn } from "../support/journey";
import { plantedFlags } from "../support/stack";

const row = (page: Page, key: string) => page.getByTestId(`flag-${key}`);

// The migrations seed no flags, so the stack plants one live flag, one on by default and one past its removal date.
test("the flags screen lists planted flags with owner, removal date and state, marks the expired one, and the founder switches an override with the password check still fresh", async ({
  page,
}) => {
  const flags = plantedFlags();
  await page.goto("/admin/flags");
  for (const flag of Object.values(flags)) {
    await expect(row(page, flag.key).getByTestId("flag-owner")).toHaveText(flag.owner);
    await expect(row(page, flag.key).getByTestId("flag-remove-by")).toContainText(flag.removeBy);
  }
  await expect(row(page, flags.live.key)).toHaveAttribute("data-state", "off");
  await expect(row(page, flags.defaultOn.key)).toHaveAttribute("data-state", "on");
  await expect(row(page, flags.live.key)).not.toHaveAttribute("data-expired", "true");

  // Expiry is shown in words and the control is unavailable, never by colour alone.
  const expired = row(page, flags.expired.key);
  await expect(expired).toHaveAttribute("data-expired", "true");
  await expect(expired.getByTestId("flag-expired")).toBeVisible();
  await expect(page.getByTestId(`override-${flags.expired.key}`)).toHaveAttribute("aria-disabled", "true");

  // The founder's last code was minutes ago, so the identity check is still fresh: no prompt, the change goes through.
  const key = flags.live.key;
  await page.getByTestId(`override-${key}`).click();
  await page.getByTestId(`override-${key}-on`).click();
  await expect(row(page, key)).toHaveAttribute("data-state", "on");
  await expect(page.getByTestId("stepup-password")).toHaveCount(0);
  await page.reload();
  await expect(row(page, key)).toHaveAttribute("data-state", "on");
});

test("a person who is not an instance admin gets the not-found page on the flags screen and a 404 from its API", async ({
  browser,
}) => {
  const { member } = await loadFounder();
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await guest.newPage();
  await signIn(page, member);
  await page.goto("/admin/flags");
  await expect(page.getByTestId("not-found")).toBeVisible();
  await expect(page.getByTestId("flag-owner")).toHaveCount(0);
  expect((await page.request.get("/api/v1/admin/flags")).status()).toBe(404);
  await guest.close();
});
