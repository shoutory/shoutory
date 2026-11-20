import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { inPage, openScreen, qualityRun } from "../support/quality";
import type { Locale, Theme } from "../support/screens";
import { DIALOGS, ERROR_PAGES, LOCALES, message, openErrorPage, SCREENS, THEMES } from "../support/screens";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const DIRECTIONS = { en: "ltr", ar: "rtl" } as const;

/** Every violation on the page, one line each: the rule and the elements it names. */
async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map(
    (found) => `${found.id}: ${found.nodes.map((node) => node.target.join(" ")).join(" | ")}`,
  );
}

/** The scan only counts if the page is in the cell it claims to be in: language, direction and theme. */
async function expectCell(page: Page, locale: Locale, theme: Theme): Promise<void> {
  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", locale);
  await expect(html).toHaveAttribute("dir", DIRECTIONS[locale]);
  await expect(html).toHaveAttribute("data-theme", theme);
}

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    const cell = `${locale}, ${theme}`;
    const options = (audience: "signed-out" | "founder") => ({ audience, locale, theme });

    for (const screen of SCREENS) {
      test(`axe finds no violation on the ${screen.id} screen (${cell})`, async ({ browser }) => {
        await inPage(browser, options(screen.audience), async (page) => {
          await openScreen(page, screen, browser);
          await expectCell(page, locale, theme);
          expect(await violations(page)).toEqual([]);
        });
      });
    }

    for (const error of ERROR_PAGES) {
      test(`axe finds no violation on the ${error.id} page (${cell})`, async ({ browser }) => {
        await inPage(browser, options("signed-out"), async (page) => {
          await openErrorPage(page, error);
          // The page must be the error page, not a fallback that happens to pass the scan.
          await expect(page).toHaveTitle(`${message(error.titleId, locale)} - Shoutory`);
          await expectCell(page, locale, theme);
          expect(await violations(page)).toEqual([]);
        });
      });
    }

    for (const dialog of DIALOGS) {
      test(`axe finds no violation on the ${dialog.id} dialog (${cell})`, async ({ browser }) => {
        const screen = SCREENS.find((entry) => entry.id === dialog.screen);
        if (!screen) throw new Error(`no screen ${dialog.screen}`);
        await inPage(browser, options(screen.audience), async (page) => {
          await openScreen(page, screen, browser);
          await dialog.open(page, (await qualityRun(browser)).context);
          await expect(page.getByRole("dialog", { name: message(dialog.titleId, locale) })).toBeVisible();
          await expectCell(page, locale, theme);
          expect(await violations(page)).toEqual([]);
        });
      });
    }
  }
}
