// The one list of screens every browser quality spec walks. It is plain data and functions of a page with type-only
// imports, so the repository's invariant can load it with Node and check it against the app's routes.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/** What a screen's address or dialog needs from the run: the founder's workspace and organization, a planted flag. */
export interface Context {
  readonly workspace: string;
  readonly organization: string;
  readonly flagKey: string;
}

export interface Screen {
  readonly id: string;
  /** The route path as the app's routes write it, with a leading slash (`*` for the catch-all). */
  readonly pattern: string;
  /** Signed out screens run in an empty browser; the others as the founder. */
  readonly audience: "signed-out" | "founder";
  readonly open: (page: Page, context: Context) => Promise<void>;
  /** The test ids of the containers on this screen that may scroll sideways; any other one is a defect. */
  readonly scrollRegions?: readonly string[];
}

export interface Dialog {
  readonly id: string;
  /** The screen the dialog opens on (a `Screen.id`); the dialog is opened after that screen is. */
  readonly screen: string;
  /** The message id of the dialog's title, which is also its accessible name. */
  readonly titleId: string;
  readonly open: (page: Page, context: Context) => Promise<void>;
}

export interface ErrorPage {
  readonly id: string;
  readonly status: number;
  readonly code: string;
  /** The message id of the page's name, which is also the start of the document title. */
  readonly titleId: string;
}

/** Routes with no screen of their own, each with the reason. */
export const EXEMPT: Readonly<Record<string, string>> = {
  admin: "the admin frame; its index only redirects to the flags screen",
  "auth/sign-in": "a redirect to the sign-in screen, for the link in a mailed message",
};

// The mailed-link part the pages accept in shape: they open and consume nothing, so any 43 base64url characters show
// the screen.
const LINK_PART = "e2e-quality-link-0123456789-ABCDEFGHIJKLMNO";

/**
 * Fails when the page's content security policy refused anything since it opened (an inline style, a script, a font):
 * a refusal the person never sees but that means the page is not as built. Events are recorded by `setPreferences`.
 */
export async function expectNoPolicyViolation(page: Page): Promise<void> {
  const refused = await page.evaluate(() => (window as unknown as { __policy?: string[] }).__policy ?? []);
  if (refused.length > 0) throw new Error(`the content security policy refused: ${refused.join(" | ")}`);
}

const ready = async (page: Page) => {
  await page.waitForLoadState("networkidle");
  await page.locator("h1").first().waitFor();
  await expectNoPolicyViolation(page);
};
const visit = (path: (context: Context) => string) => async (page: Page, context: Context) => {
  await page.goto(path(context));
  await ready(page);
};
const signedOut = (id: string, pattern: string, path = pattern): Screen => ({
  id,
  pattern,
  audience: "signed-out",
  open: visit(() => path),
});
const founder = (
  id: string,
  pattern: string,
  path: (context: Context) => string,
  scrollRegions: readonly string[] = [],
): Screen => ({ id, pattern, audience: "founder", open: visit(path), scrollRegions });

export const SCREENS: readonly Screen[] = [
  signedOut("sign-in", "/sign-in"),
  // The challenge screen is open only after a password step; the spec makes that step before it opens this.
  signedOut("mfa", "/mfa"),
  signedOut("sign-up", "/sign-up"),
  signedOut("forgot", "/forgot"),
  signedOut("verify", "/auth/verify", `/auth/verify#${LINK_PART}`),
  signedOut("reset", "/auth/reset", `/auth/reset#${LINK_PART}`),
  signedOut("invite", "/invite/:token", `/invite/${LINK_PART}`),
  signedOut("session-expired", "/session-expired"),
  signedOut("not-found", "*", "/no-such-screen"),
  founder("start", "/", () => "/"),
  founder("profile", "/account/profile", () => "/account/profile"),
  founder("security", "/account/security", () => "/account/security", ["sessions-scroll"]),
  founder("two-factor-setup", "/account/security/two-factor", () => "/account/security/two-factor"),
  founder("workspace", "/w/:ws", (c) => `/w/${c.workspace}`),
  founder("general", "/w/:ws/settings/general", (c) => `/w/${c.workspace}/settings/general`),
  founder("members", "/w/:ws/settings/members", (c) => `/w/${c.workspace}/settings/members`, [
    "members-scroll",
    "invitations-scroll",
  ]),
  founder("clients", "/o/:org/clients", (c) => `/o/${c.organization}/clients`, ["clients-scroll"]),
  founder("billing", "/o/:org/billing", (c) => `/o/${c.organization}/billing`),
  founder("flags", "/admin/flags", () => "/admin/flags", ["flags-scroll"]),
  founder("queue", "/admin/queue", () => "/admin/queue", ["queue-scroll"]),
  founder("system", "/admin/system", () => "/admin/system"),
  founder("releases", "/admin/releases", () => "/admin/releases"),
  founder("providers", "/admin/providers", () => "/admin/providers"),
  founder("signup-switch", "/admin/signup", () => "/admin/signup"),
];

/** Pages for a failed session read, shown by answering that read: forbidden, maintenance and the start-up failure. */
export const ERROR_PAGES: readonly ErrorPage[] = [
  { id: "forbidden", status: 403, code: "forbidden", titleId: "system.forbidden.title" },
  { id: "maintenance", status: 503, code: "service_unavailable", titleId: "system.maintenance.title" },
  { id: "startup-failure", status: 500, code: "internal_error", titleId: "system.startup_failure.title" },
];

/** The words of a message in a language, read from the app's own catalogue, so a spec never repeats a translation. */
export function message(id: string, locale: Locale): string {
  const file = new URL(`../../apps/web/src/messages/${locale}.po`, import.meta.url);
  const catalogue = readFileSync(file, "utf8");
  const found = new RegExp(`^msgid "${id}"\\nmsgstr "(.*)"$`, "m").exec(catalogue);
  if (!found?.[1]) throw new Error(`no ${locale} message ${id}`);
  return found[1];
}

/** Opens an error page: the guarded screen asks for the session, and the answer is the failure. */
export async function openErrorPage(page: Page, error: ErrorPage): Promise<void> {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      status: error.status,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: error.code, message: "refused", requestId: "e2e-quality" } }),
    }),
  );
  await page.goto("/account/profile");
  await ready(page);
}

const dialog = async (page: Page) => page.getByRole("dialog").waitFor();

export const DIALOGS: readonly Dialog[] = [
  {
    id: "palette",
    screen: "workspace",
    titleId: "shell.palette.title",
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await dialog(page);
    },
  },
  {
    id: "invite",
    screen: "members",
    titleId: "invite.title",
    open: async (page) => {
      await page.getByTestId("invite-open").click();
      await dialog(page);
    },
  },
  {
    id: "add-client",
    screen: "clients",
    titleId: "org.clients.add",
    open: async (page) => {
      await page.getByTestId("clients-add").click();
      await dialog(page);
    },
  },
  {
    // The password check appears when the server says a recent check is needed: the first override call is answered so.
    id: "step-up",
    screen: "flags",
    titleId: "auth.step_up.title",
    open: async (page, context) => {
      await page.route(`**/api/v1/admin/flags/${context.flagKey}/override`, (route) =>
        route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "step_up_required", message: "refused", requestId: "e2e" } }),
        }),
      );
      await page.getByTestId(`override-${context.flagKey}`).click();
      // The flag has no override, so "off" is a change; choosing the value it already has would send nothing.
      await page.getByTestId(`override-${context.flagKey}-off`).click();
      await dialog(page);
    },
  },
];

export const LOCALES = ["en", "ar"] as const;
export const THEMES = ["light", "dark"] as const;
export type Locale = (typeof LOCALES)[number];
export type Theme = (typeof THEMES)[number];

/** Where a screen reads the person's choices: the app's own storage keys (and the system preference for the theme). */
export async function setPreferences(page: Page, locale: Locale, theme: Theme): Promise<void> {
  await page.addInitScript(
    ([language, scheme]) => {
      localStorage.setItem("shoutory.locale", language ?? "en");
      localStorage.setItem("shoutory.theme", scheme ?? "light");
    },
    [locale, theme],
  );
  await page.addInitScript(() => {
    const refused: string[] = [];
    (window as unknown as { __policy: string[] }).__policy = refused;
    document.addEventListener("securitypolicyviolation", (event) => {
      const where = `${event.sourceFile}:${event.lineNumber}`;
      refused.push(
        `${event.violatedDirective} ${event.blockedURI} at ${where} ${event.sample}`.slice(0, 200),
      );
    });
  });
  await page.emulateMedia({ colorScheme: theme });
}

/** The ids the founder's addresses need: its workspace and the organization the workspace belongs to. */
export async function founderContext(page: Page, workspace: string, flagKey: string): Promise<Context> {
  const mine = (await (await page.request.get("/api/v1/workspaces")).json()) as {
    data: ReadonlyArray<{ id: string; organization_id: string }>;
  };
  const organization = mine.data.find((entry) => entry.id === workspace)?.organization_id;
  if (!organization) throw new Error("the founder's workspace is not in its workspace list");
  return { workspace, organization, flagKey };
}
