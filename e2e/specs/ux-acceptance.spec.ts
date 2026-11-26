import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { createClient, loadFounder, loadMember, signIn } from "../support/journey";
import { inPage, openScreen, refreshStepUp } from "../support/quality";
import { expectNoPolicyViolation, message, SCREENS } from "../support/screens";
import { plantedFlags } from "../support/stack";
import { nextTotp } from "../support/totp";

function gate(): { held: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

test("the loading status stays quiet for 300 ms, then says loading, and offers a retry after 10 s", async ({
  page,
}) => {
  const { workspace } = await loadFounder();
  const { held, release } = gate();
  await page.route("**/api/auth/get-session", async (route) => {
    await held;
    await route.continue();
  });
  // Time stands still until the test moves it, so the 300 ms and the 10 s are exact.
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1_000);
  await page.goto(`/w/${workspace.id}`, { waitUntil: "commit" });
  const status = page.locator('[role="status"][aria-busy="true"]');
  await expect(status).toBeAttached();
  await expect(status).toHaveText("");
  await page.clock.fastForward(299);
  await expect(status).toHaveText("");
  await page.clock.fastForward(1);
  await expect(status).not.toHaveText("");
  await page.clock.fastForward(9_700);
  await expect(status.locator("button")).toBeVisible();
  release();
  await expect(page.getByTestId("workspace-name")).toBeVisible();
});

test("a flag switch shows busy and keeps its value until the server answers, and switching back undoes it", async ({
  page,
}) => {
  const { secret } = await loadFounder();
  const key = plantedFlags().defaultOn.key;
  const row = page.getByTestId(`flag-${key}`);
  const select = page.getByTestId(`override-${key}`);
  await page.goto("/admin/flags");
  await refreshStepUp(page, secret);
  const { held, release } = gate();
  await page.route(`**/api/v1/admin/flags/${key}/override`, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await expect(row).toHaveAttribute("data-state", "on");
    await select.click();
    await page.getByTestId(`override-${key}-off`).click();
    await expect(select).toHaveAttribute("aria-disabled", "true");
    await expect(row).toHaveAttribute("data-state", "on");
    release();
    await expect(row).toHaveAttribute("data-state", "off");
    await expect(select).not.toHaveAttribute("aria-disabled", "true");

    // The change is reversible by the same control, which is why it asks no question first.
    await select.click();
    await page.getByTestId(`override-${key}-default`).click();
    await expect(row).toHaveAttribute("data-state", "on");
  } finally {
    // A failed run leaves no override on the instance for the specs after it.
    release();
    await page.unroute(`**/api/v1/admin/flags/${key}/override`);
    const status = await page.evaluate(async (path) => {
      const answer = await fetch(path, {
        method: "PUT",
        headers: { "content-type": "application/json", "X-Shoutory-Client": "web" },
        body: JSON.stringify({ on: null }),
      });
      return answer.status;
    }, `/api/v1/admin/flags/${key}/override`);
    expect(status, "the override is cleared").toBe(200);
  }
});

// A guarded page: an open dialog makes React Aria lock the page's scroll with an injected style, and the content
// policy must allow it.
test("removing a member names the member and what ends first, and Cancel leaves the member", async ({
  browser,
}) => {
  const { workspace } = await loadFounder();
  const target = loadMember("keyboard").account;
  await inPage(browser, { audience: "founder", locale: "en", theme: "light" }, async (page) => {
    await page.goto(`/w/${workspace.id}/settings/members`);
    const row = page.locator("tr", { hasText: target.name });
    await row.getByTestId("member-remove").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(target.name);
    await expect(dialog).toContainText(message("members.remove_body", "en"));
    await dialog.getByTestId("confirm-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();
  });
});

// The invitations load beside the members, not after them, so reading the members again leaves the open invite
// dialog, its typed address and its focus where they were.
test("a retry of the members list keeps the invite dialog, its typed address and its focus", async ({
  browser,
}) => {
  const { workspace } = await loadFounder();
  const address = "typed-before-retry@example.test";
  await inPage(browser, { audience: "founder", locale: "en", theme: "light" }, async (page) => {
    let refused = false;
    await page.route(/\/members\?limit=100/, (route) => {
      if (refused) return route.continue();
      refused = true;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unavailable", message: "held", requestId: "e2e-retry" } }),
      });
    });
    await page.goto(`/w/${workspace.id}/settings/members`);
    const retry = page.locator("main button", { hasText: "Retry" });
    await expect(retry).toBeVisible();
    await page.getByTestId("invite-open").click();
    const input = page.getByTestId("invite-email");
    await input.fill(address);
    // The dialog covers the page, so the retry is pressed in the page itself.
    await retry.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.getByTestId("members-scroll")).toBeAttached();
    await expect(input).toHaveValue(address);
    await expect(input).toBeFocused();
  });
});

// A person who is only a member of one workspace has no organization in the app's lists, yet the workspace's own type
// opens its members page for them; a workspace the person cannot see answers as unknown.
test("a workspace-only member opens its members page and a stranger gets the not-found page", async ({
  browser,
  page,
}) => {
  const { workspace, member } = await loadFounder();
  await page.goto(`/w/${randomUUID()}/settings/members`);
  await expect(page.getByTestId("not-found")).toBeVisible();

  await inPage(browser, { audience: "signed-out", locale: "en", theme: "light" }, async (viewer) => {
    await signIn(viewer, member);
    await viewer.goto(`/w/${workspace.id}/settings/members`);
    await viewer.waitForLoadState("networkidle");
    await expectNoPolicyViolation(viewer);
    await expect(viewer.locator("main h1")).toBeVisible();
    await expect(viewer.getByTestId("not-found")).toHaveCount(0);
  });
});

interface Target {
  html: string;
  width: number;
  height: number;
  hidden: boolean;
  inline: boolean;
}

const targets = (page: Page): Promise<Target[]> =>
  page.evaluate(() => {
    const SELECTOR = 'button, input:not([type="hidden"]), select, textarea, [role="combobox"], a[href]';
    return [...document.querySelectorAll(SELECTOR)].map((element) => {
      // A radio button or checkbox is pressed through the label that holds it.
      const pressed = element.matches('input[type="radio"], input[type="checkbox"]')
        ? (element.closest("label") ?? element)
        : element;
      const box = pressed.getBoundingClientRect();
      const text = (element.textContent ?? "").trim();
      return {
        html: element.outerHTML.slice(0, 90),
        width: box.width,
        height: box.height,
        hidden: element.closest('[aria-hidden="true"]') !== null,
        inline: element.matches("a") && (element.parentElement?.textContent ?? "").trim() !== text,
      };
    });
  });

/** Controls smaller than 24 px either way (a one-pixel box is text kept for assistive technology, not a control). */
async function smallTargets(page: Page): Promise<string[]> {
  const all = await targets(page);
  return all
    .filter((one) => !one.hidden && !one.inline && one.width > 1 && one.height > 1)
    .filter((one) => one.width < 24 || one.height < 24)
    .map((one) => one.html);
}

for (const screen of SCREENS) {
  test(`every control on the ${screen.id} screen is at least 24 px`, async ({ browser }) => {
    await inPage(browser, { audience: screen.audience, locale: "en", theme: "light" }, async (page) => {
      await openScreen(page, screen, browser);
      expect(await smallTargets(page)).toEqual([]);
    });
  });
}

// web.dev calls a total shift of 0.1 or less good. The server's answers are held for longer than the 300 ms the loading
// placeholder waits, so a slow machine's case is the case on every machine.
const SHIFT_LIMIT = 0.1;
const HOLD_MS = 600;
for (const id of ["workspace", "members", "flags", "security"]) {
  test(`the ${id} screen shifts less than ${SHIFT_LIMIT} while it loads, with its data held for ${HOLD_MS} ms`, async ({
    browser,
  }) => {
    const screen = SCREENS.find((entry) => entry.id === id);
    if (!screen) throw new Error(`no screen ${id}`);
    await inPage(browser, { audience: "founder", locale: "en", theme: "light" }, async (page) => {
      // The faces too: a face that arrives late replaces the fallback and can move every line of text.
      await page.route(/\/api\/|\.woff2?$/, async (route) => {
        await new Promise((done) => setTimeout(done, HOLD_MS));
        await route.continue();
      });
      await page.addInitScript(() => {
        const w = window as unknown as { __shift: number; __moved: string[] };
        w.__shift = 0;
        w.__moved = [];
        type Rect = { x: number; y: number; width: number; height: number };
        type Source = { node: Element | null; previousRect: Rect; currentRect: Rect };
        type Shift = { value: number; hadRecentInput: boolean; sources: Source[] };
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as Shift[]) {
            if (entry.hadRecentInput) continue;
            w.__shift += entry.value;
            const named = entry.sources.map((source) => {
              const node = source.node;
              if (!node) return "(removed)";
              const { previousRect: was, currentRect: now } = source;
              const box = (rect: Rect) =>
                `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
              return `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)} (${box(was)} -> ${box(now)})`;
            });
            const bar = document.querySelector("nav");
            const root = document.documentElement;
            const bearing = bar ? getComputedStyle(bar).position : "none";
            const where = `${innerWidth}x${innerHeight}px, ${root.lang} ${root.dir}, bar ${bearing}`;
            w.__moved.push(`${entry.value.toFixed(3)} [${where}] ${named.join(", ")}`);
          }
        }).observe({ type: "layout-shift", buffered: true });
        addEventListener("resize", () => w.__moved.push(`(resized to ${innerWidth}px)`));
      });
      await openScreen(page, screen, browser);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const seen = await page.evaluate(() => {
        const w = window as unknown as { __shift: number; __moved: string[] };
        return { shift: w.__shift, moved: w.__moved };
      });
      expect(seen.shift, `what moved: ${seen.moved.join(" | ")}`).toBeLessThan(SHIFT_LIMIT);
    });
  });
}

// A runner's fallback face is wider than the web font, and a top bar that wraps with one face and not with the other
// moves the whole page when the web font arrives. The web fonts are blocked and the text is spaced wider than any
// face would set it, so the check is the same on every machine.
const WIDE_TEXT = 0.1;
const MIN_INPUT = 80;
let secondWorkspace: Promise<unknown> | undefined;
const withSecondWorkspace = (browser: Browser) => {
  secondWorkspace ??= inPage(browser, { audience: "founder", locale: "en", theme: "light" }, (page) =>
    createClient(page, "top-bar-client"),
  );
  return secondWorkspace;
};
for (const locale of ["en", "ar"] as const) {
  for (const width of [1280, 1024, 768]) {
    topBarCase(locale, width);
  }
}

function topBarCase(locale: "en" | "ar", width: number) {
  const rows = width >= 1024 ? "one row" : "inputs of at least the minimum and no sideways scroll";
  test(`the top bar has ${rows} at ${width} px (${locale}) with wide fallback text in place of the web fonts`, async ({
    browser,
  }) => {
    const { workspace } = await loadFounder();
    await withSecondWorkspace(browser);
    const options = {
      audience: "founder",
      locale,
      theme: "light",
      viewport: { width, height: 720 },
      bypassCSP: true,
    } as const;
    await inPage(browser, options, async (page) => {
      await page.route(/\.woff2?$/, (route) => route.abort());
      await page.addInitScript((spacing) => {
        const style = document.createElement("style");
        style.textContent = `* { letter-spacing: ${spacing}em !important; }`;
        document.addEventListener("DOMContentLoaded", () => document.head.append(style));
      }, WIDE_TEXT);
      await page.goto(`/w/${workspace.id}`);
      const bar = page.locator("header").first();
      await expect(page.getByTestId("workspace-name")).toBeVisible();
      // One row is the height of its tallest control and the bar's padding; a second row adds a control's height again.
      const seen = await bar.evaluate((header) => ({
        barHeight: header.getBoundingClientRect().height,
        controlHeight: Math.max(
          ...[...header.querySelectorAll("button, input, a")].map((e) => e.getBoundingClientRect().height),
        ),
        inputs: [...header.querySelectorAll("input")].map((e) => Math.round(e.getBoundingClientRect().width)),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      expect(seen.inputs.length, "both switchers are in the bar").toBe(2);
      expect(Math.min(...seen.inputs), `input widths ${seen.inputs.join(", ")}`).toBeGreaterThanOrEqual(
        MIN_INPUT,
      );
      expect(seen.overflow, "the page scrolls sideways by this many px").toBeLessThanOrEqual(0);
      if (width >= 1024) {
        expect(
          seen.barHeight,
          `the bar is ${seen.barHeight} px tall, its tallest control ${seen.controlHeight} px`,
        ).toBeLessThan(seen.controlHeight + 40);
      }
    });
  });
}

// Archive is three steps (open the clients, Archive, confirm) and Restore two; the workspace is active again at the end.
test("archiving a client states its impact first, marks the workspace read-only, and Restore undoes it", async ({
  browser,
}) => {
  await inPage(browser, { audience: "founder", locale: "en", theme: "light" }, async (page) => {
    const client = await createClient(page, `Archive target ${randomUUID().slice(0, 8)}`);
    await page.goto(`/o/${client.organization}/clients`);
    const row = page.locator("tr", { hasText: client.name });
    await row.getByTestId("workspace-archive").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(message("archive.impact", "en"));
    await dialog.getByRole("button", { name: message("archive.archive", "en") }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toHaveCount(0);
    await page.goto(`/w/${client.id}`);
    const banner = page.getByTestId("archived-banner");
    await expect(banner).toContainText(client.name);
    await banner.getByTestId("workspace-restore").click();
    await expect(banner).toBeHidden();
  });
});

// Last in its project: this person makes an organization of their own, which nothing after it may count on. They signed
// up through an invitation they never accepted, so they have no workspace and are shown the form that makes one.
test("a creator-only account shows no organization, client or billing UI, and gets its workspace from one form", async ({
  browser,
}) => {
  const { account, secret } = loadMember("paste");
  await inPage(browser, { audience: "signed-out", locale: "en", theme: "light" }, async (page) => {
    await signIn(page, account);
    await page.waitForURL(/\/mfa/);
    await page.getByTestId("mfa-code").fill(await nextTotp(secret));
    await page.getByTestId("mfa-submit").click();
    await page.getByTestId("onboarding-organization").fill("Just me");
    await page.getByTestId("onboarding-workspace").fill("My space");
    await page.getByTestId("onboarding-type-personal").click();
    await page.getByTestId("onboarding-create").click();
    await page.waitForURL(/\/w\//);
    await expect(page.getByTestId("workspace-name")).toBeVisible();
    await expect(page.getByTestId("switcher-organization")).toHaveCount(0);
    await expect(page.locator('a[href*="/clients"], a[href*="/billing"]')).toHaveCount(0);
  });
});
