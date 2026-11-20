import { expect, type Page, test } from "@playwright/test";
import { inPage, openScreen } from "../support/quality";
import { LOCALES, SCREENS } from "../support/screens";

const NARROW = { width: 320, height: 256 };
// Browser zoom of 200% on a 1280 x 720 window leaves this many CSS pixels.
const ZOOMED = { width: 640, height: 360 };
const CONTROLS =
  'a[href], button, input, select, textarea, [role="combobox"], [tabindex]:not([tabindex="-1"])';

/**
 * Containers whose content is wider than they are, and which either scroll it or cut it off, and are not in `named`
 * (by test id): each is a defect. Text hidden on purpose (assistive technology only, or aria-hidden) does not count.
 */
const unnamedOverflow = (page: Page, named: readonly string[]) =>
  page.evaluate((allowed) => {
    const clips = (element: Element) =>
      /auto|scroll|hidden|clip/.test(getComputedStyle(element).overflowX) &&
      element.scrollWidth > element.clientWidth;
    // A text field whose text is longer than the field scrolls that text itself; that is not layout overflow.
    const shown = (element: Element) =>
      element.getBoundingClientRect().width > 1 &&
      element.closest('[aria-hidden="true"]') === null &&
      !element.matches("input, textarea, select");
    return [...document.body.querySelectorAll("*")]
      .filter((element) => clips(element) && shown(element))
      .filter((element) => !allowed.includes(element.getAttribute("data-testid") ?? ""))
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)}`);
  }, named);

/** The controls a person cannot reach after scrolling to them: outside the viewport sideways, or covered. */
async function unreachableControls(page: Page): Promise<string[]> {
  const controls = page.locator(CONTROLS);
  const unreachable: string[] = [];
  for (let at = 0; at < (await controls.count()); at += 1) {
    const control = controls.nth(at);
    // A control hidden from assistive technology (the native copy of a select, kept for forms) is not one.
    const hidden = await control.evaluate((element) => element.closest('[aria-hidden="true"]') !== null);
    if (hidden || !(await control.isVisible())) continue;
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    if (!box || box.width <= 1) continue;
    const inside = box.x >= -1 && box.x + box.width <= ZOOMED.width + 1;
    // Reachable also means nothing sits on top of it: a press at its centre lands on it, or on its own label (a radio
    // button is pressed through the label that holds it).
    const exposed = await control.evaluate((element) => {
      // A link whose text wraps has one box per line; its overall box can have a gap at the centre, so the first line.
      const rect = element.getClientRects()[0] ?? element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const label = element.closest("label");
      return top === element || element.contains(top) || (label !== null && label.contains(top));
    });
    if (!inside || !exposed) {
      unreachable.push(await control.evaluate((element) => element.outerHTML.slice(0, 80)));
    }
  }
  return unreachable;
}

for (const locale of LOCALES) {
  for (const screen of SCREENS) {
    // Layout does not depend on the colours, so the light theme stands for both.
    test(`reflow: the ${screen.id} screen fits 320 px and stays reachable at 200% (${locale})`, async ({
      browser,
    }) => {
      const options = { audience: screen.audience, locale, theme: "light" as const, viewport: NARROW };
      await inPage(browser, options, async (page) => {
        await openScreen(page, screen, browser);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
        expect(await unnamedOverflow(page, screen.scrollRegions ?? [])).toEqual([]);
        // A region the catalogue names must be on the screen, or the allowance names something that is not there.
        for (const region of screen.scrollRegions ?? []) {
          await expect(page.getByTestId(region), `scroll region ${region}`).toHaveCount(1);
        }

        await page.setViewportSize(ZOOMED);
        const unreachable = await unreachableControls(page);
        expect(unreachable, "controls outside the zoomed viewport or covered").toEqual([]);
      });
    });
  }
}
