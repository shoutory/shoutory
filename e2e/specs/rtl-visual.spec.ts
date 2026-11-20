import { expect, type Page, test } from "@playwright/test";
import { inPage, openScreen } from "../support/quality";
import { ERROR_PAGES, LOCALES, openErrorPage, SCREENS, THEMES } from "../support/screens";
import { freezeVolatileValues, masksFor } from "../support/visual";

// The widths of the three layouts: the bottom bar, the collapsed rail and the full rail. A screen is compared with its
// baseline in each language and theme, so a layout that does not mirror under `dir=rtl` changes a picture.
const SIZES = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

/** The screen as it will be photographed: faces loaded, nothing moving. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

const shot = (page: Page, name: string, masks: ReturnType<typeof masksFor>) =>
  expect(page).toHaveScreenshot(`${name}.png`, { animations: "disabled", caret: "hide", mask: masks });

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    for (const viewport of SIZES) {
      const cell = `${viewport.width} px, ${locale}, ${theme}`;
      const name = (id: string) => `${id}-${viewport.width}-${locale}-${theme}`;

      for (const screen of SCREENS) {
        test(`visual: the ${screen.id} screen matches its baseline (${cell})`, async ({ browser }) => {
          await inPage(browser, { audience: screen.audience, locale, theme, viewport }, async (page) => {
            await freezeVolatileValues(page);
            await openScreen(page, screen, browser);
            await settle(page);
            await shot(page, name(screen.id), masksFor(page, screen.id, screen.audience === "founder"));
          });
        });
      }

      for (const error of ERROR_PAGES) {
        test(`visual: the ${error.id} page matches its baseline (${cell})`, async ({ browser }) => {
          await inPage(browser, { audience: "signed-out", locale, theme, viewport }, async (page) => {
            await openErrorPage(page, error);
            await settle(page);
            await shot(page, name(error.id), []);
          });
        });
      }
    }
  }
}
