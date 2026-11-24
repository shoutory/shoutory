import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import {
  type Account,
  FOUNDER_STATE,
  inviteMember,
  loadFounder,
  loadMember,
  newAccount,
  signIn,
} from "./journey";
import { waitForFreshCode } from "./restore";
import {
  type Context,
  expectNoPolicyViolation,
  founderContext,
  type Locale,
  type Screen,
  setPreferences,
  type Theme,
} from "./screens";
import { plantedFlags, STATE_DIR } from "./stack";
import { nextTotp } from "./totp";

const SIGNED_OUT = { cookies: [], origins: [] };

let shared: Promise<{ context: Context; member: Account }> | undefined;
const FACTS = `${STATE_DIR}/quality.json`;

// The member is one an earlier spec made: sign-up is limited to five an hour from one address, and the run's other
// specs already use them all. The facts are kept in the state folder, since Playwright starts a new process after a
// failed test.
export function qualityRun(browser: Browser): Promise<{ context: Context; member: Account }> {
  shared ??= (async () => {
    if (existsSync(FACTS))
      return JSON.parse(readFileSync(FACTS, "utf8")) as { context: Context; member: Account };
    const made = await makeQualityRun(browser);
    writeFileSync(FACTS, JSON.stringify(made));
    return made;
  })();
  return shared;
}

async function makeQualityRun(browser: Browser): Promise<{ context: Context; member: Account }> {
  const founder = await loadFounder();
  const owner = await browser.newContext({ storageState: FOUNDER_STATE });
  try {
    const page = await owner.newPage();
    const context = await founderContext(page, founder.workspace.id, plantedFlags().defaultOn.key);
    // A pending invitation, never accepted, so the members screen shows its invitations table too.
    await inviteMember(page, founder.workspace.id, newAccount("pending").email);
    return { context, member: loadMember("keyboard").account };
  } finally {
    await owner.close();
  }
}

export async function inPage<T>(
  browser: Browser,
  options: {
    audience: Screen["audience"];
    locale: Locale;
    theme: Theme;
    viewport?: { width: number; height: number };
    /** For a check that adds its own style to the page, which the page's content policy would refuse. */
    bypassCSP?: boolean;
  },
  use: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    storageState: options.audience === "founder" ? FOUNDER_STATE : SIGNED_OUT,
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.bypassCSP ? { bypassCSP: true } : {}),
  });
  try {
    const page = await context.newPage();
    await setPreferences(page, options.locale, options.theme);
    const result = await use(page);
    // A refusal that comes after the screen is ready (an overlay's style, a late script) is caught here.
    if (!page.isClosed()) await expectNoPolicyViolation(page);
    return result;
  } finally {
    await context.close();
  }
}

// The founder has the second factor on, so a password check would not count. The run outlasts the ten minutes of the
// check made at sign-in.
export async function refreshStepUp(page: Page, secret: string): Promise<void> {
  await waitForFreshCode();
  const code = await nextTotp(secret);
  const status = await page.evaluate(async (value) => {
    const answer = await fetch("/api/auth/two-factor/verify-totp", {
      method: "POST",
      // The app's own client sends this header on every call, and the server refuses a call without it.
      headers: { "content-type": "application/json", "X-Shoutory-Client": "web" },
      body: JSON.stringify({ code: value }),
    });
    return answer.status;
  }, code);
  if (status !== 200) throw new Error(`the code check answered ${status}`);
}

// This replaces the codes made at enrolment, which no other spec uses.
export async function newRecoveryCodes(
  page: Page,
  password: string,
  secret: string,
  /** False for a session that has just signed in with a code, whose identity check is fresh already. */
  refresh = true,
): Promise<string[]> {
  await page.goto("/account/security");
  if (refresh) await refreshStepUp(page, secret);
  await page.getByTestId("codes-new").click();
  await page.getByTestId("codes-password").fill(password);
  await page.getByTestId("codes-generate").click();
  await page.getByTestId("recovery-codes").waitFor();
  return page.getByTestId("recovery-code").allTextContents();
}

// The challenge screen only opens after a password step, which is made first.
export async function openScreen(page: Page, screen: Screen, browser: Browser): Promise<void> {
  const { context, member } = await qualityRun(browser);
  if (screen.id === "mfa") {
    await signIn(page, member);
    await page.waitForURL(/\/mfa/);
  }
  await screen.open(page, context);
}
