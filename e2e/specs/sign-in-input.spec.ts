import { expect, type Page, test } from "@playwright/test";
import { createMember, loadFounder } from "../support/journey";
import { setPreferences } from "../support/screens";
import { nextTotp } from "../support/totp";

const CAPTCHA = 'iframe, [data-sitekey], [class*="captcha" i], [id*="captcha" i]';

async function paste(page: Page, id: string, text: string): Promise<void> {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.getByTestId(id).focus();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.getByTestId(id)).toHaveValue(text);
}

// An authenticator or keyboard set to Arabic gives U+0660..U+0669; the code reaches the server as ASCII digits.
const arabicIndic = (code: string) =>
  code.replaceAll(/\d/g, (digit) => String.fromCodePoint(0x660 + Number(digit)));

// One test, one member: sign-up is limited per IP and a person's code is taken once per ninety seconds.
test("sign-in in Arabic accepts a pasted password and a pasted code in Arabic-Indic digits, the code field has autocomplete=one-time-code, and no CAPTCHA appears", async ({
  page,
  browser,
}) => {
  const founder = await loadFounder();
  const { account, secret } = await createMember({
    browser,
    inviter: page,
    label: "paste",
    workspaces: [founder.workspace],
    // The person needs the invitation to sign up, not the workspace: the invitation stays pending.
    accept: false,
  });
  const guest = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const seen = await guest.newPage();
  await setPreferences(seen, "ar", "light");
  await seen.goto("/sign-in");
  await expect(seen.locator("html")).toHaveAttribute("lang", "ar");
  await expect(seen.locator(CAPTCHA)).toHaveCount(0);
  await seen.getByTestId("sign-in-email").fill(account.email);
  await paste(seen, "sign-in-password", account.password);
  await seen.getByTestId("sign-in-submit").click();

  await seen.waitForURL(/\/mfa/);
  await expect(seen.getByTestId("mfa-code")).toHaveAttribute("autocomplete", "one-time-code");
  await expect(seen.locator(CAPTCHA)).toHaveCount(0);
  await paste(seen, "mfa-code", arabicIndic(await nextTotp(secret)));
  await seen.getByTestId("mfa-submit").click();
  await expect(seen.getByTestId("onboarding-create")).toBeVisible();
  await guest.close();
});
