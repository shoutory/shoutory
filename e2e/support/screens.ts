// Only type imports, so the repository's invariant can load this file with Node and check it against the app's routes.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

export interface Context {
  readonly workspace: string;
  readonly organization: string;
  readonly flagKey: string;
}

export interface Screen {
  readonly id: string;
  readonly pattern: string;
  readonly audience: "signed-out" | "founder";
  readonly open: (page: Page, context: Context) => Promise<void>;
  readonly scrollRegions?: readonly string[];
}

export interface Dialog {
  readonly id: string;
  readonly screen: string;
  readonly titleId: string;
  readonly open: (page: Page, context: Context) => Promise<void>;
}

export interface ErrorPage {
  readonly id: string;
  readonly status: number;
  readonly code: string;
  readonly titleId: string;
}

export const EXEMPT: Readonly<Record<string, string>> = {
  admin: "the admin frame; its index only redirects to the flags screen",
  "auth/sign-in": "a redirect to the sign-in screen, for the link in a mailed message",
};

// The mailed-link part the pages accept in shape: they open and consume nothing, so any 43 base64url characters show
// the screen.
const LINK_PART = "e2e-quality-link-0123456789-ABCDEFGHIJKLMNO";

// A refusal the person never sees still means the page is not as built. Events are recorded by `setPreferences`.
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

// The image registers no channel routes (the app is built with no provider), so the channels hub is shown from fixed
// answers. The columns of a channel are read from the route that writes them, so a column added there is a field here.
const CHANNEL_CARDS = [
  {
    id: "0190a000-0000-7000-8000-0000000001a1",
    display_name: "Acme Page",
    handle: "@acme_page",
    connection_state: "connected",
    health: "ok",
    health_checked_at: "2026-11-22T10:00:00.000Z",
    actions: ["check"],
  },
  {
    id: "0190a000-0000-7000-8000-0000000001a2",
    display_name: "Acme Shop",
    handle: "@acme_shop",
    connection_state: "needs_reconnect",
    reconnect_deadline: "2026-12-01T00:00:00.000Z",
    actions: ["reconnect"],
  },
  {
    id: "0190a000-0000-7000-8000-0000000001a3",
    display_name: "Acme Blog",
    handle: null,
    connection_state: "disconnected",
    actions: ["reconnect"],
  },
];

function channelColumns(): string[] {
  const source = readFileSync(
    new URL("../../apps/api/src/routes/channels/channels.ts", import.meta.url),
    "utf8",
  );
  const found = /const ANSWER = `([^`]+)`/.exec(source);
  if (!found?.[1]) throw new Error("the columns of a channel answer were not found in the channels route");
  return found[1].split(",").map((column) => column.trim());
}

async function fulfilHub(page: Page, workspace: string): Promise<void> {
  const columns = channelColumns();
  const rows = CHANNEL_CARDS.map((card) => ({
    ...Object.fromEntries(columns.map((column) => [column, null])),
    provider_id: "example_network",
    account_kind: "profile",
    capability_epoch: 0,
    ...card,
  }));
  const reply = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.addInitScript(() => localStorage.setItem("shoutory.zone", "UTC"));
  await page.route(`**/api/v1/workspaces/${workspace}/channels`, (route) =>
    route.fulfill(reply({ data: rows, meta: { next_cursor: null, actions: [] } })),
  );
  await page.route(`**/api/v1/workspaces/${workspace}/providers`, (route) =>
    route.fulfill(
      reply({
        data: [
          {
            id: "example_network",
            display_name: "Example Network",
            lifecycle: "ga",
            auth_kind: "oauth2_pkce",
            connectable: true,
            needs_instance_host: false,
          },
        ],
      }),
    ),
  );
}

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
  {
    id: "channels",
    pattern: "/w/:ws/channels",
    audience: "founder",
    open: async (page, context) => {
      await fulfilHub(page, context.workspace);
      await visit((c) => `/w/${c.workspace}/channels`)(page, context);
    },
  },
  founder("media", "/w/:ws/media", (c) => `/w/${c.workspace}/media`),
  // The outcome that needs no channel read, so the screen is the same on every run.
  founder("connect-result", "/connect/result", () => "/connect/result?reason=rate_limited"),
  founder("clients", "/o/:org/clients", (c) => `/o/${c.organization}/clients`, ["clients-scroll"]),
  founder("billing", "/o/:org/billing", (c) => `/o/${c.organization}/billing`),
  founder("flags", "/admin/flags", () => "/admin/flags", ["flags-scroll"]),
  founder("queue", "/admin/queue", () => "/admin/queue", ["queue-scroll"]),
  founder("system", "/admin/system", () => "/admin/system"),
  founder("releases", "/admin/releases", () => "/admin/releases"),
  founder("providers", "/admin/providers", () => "/admin/providers"),
  founder("signup-switch", "/admin/signup", () => "/admin/signup"),
];

export const ERROR_PAGES: readonly ErrorPage[] = [
  { id: "forbidden", status: 403, code: "forbidden", titleId: "system.forbidden.title" },
  { id: "maintenance", status: 503, code: "service_unavailable", titleId: "system.maintenance.title" },
  { id: "startup-failure", status: 500, code: "internal_error", titleId: "system.startup_failure.title" },
];

// Read from the app's own catalogue, so a spec never repeats a translation.
export function message(id: string, locale: Locale): string {
  const file = new URL(`../../apps/web/src/messages/${locale}.po`, import.meta.url);
  const catalogue = readFileSync(file, "utf8");
  const found = new RegExp(`^msgid "${id}"\\nmsgstr "(.*)"$`, "m").exec(catalogue);
  if (!found?.[1]) throw new Error(`no ${locale} message ${id}`);
  return found[1];
}

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

export async function founderContext(page: Page, workspace: string, flagKey: string): Promise<Context> {
  const mine = (await (await page.request.get("/api/v1/workspaces")).json()) as {
    data: ReadonlyArray<{ id: string; organization_id: string }>;
  };
  const organization = mine.data.find((entry) => entry.id === workspace)?.organization_id;
  if (!organization) throw new Error("the founder's workspace is not in its workspace list");
  return { workspace, organization, flagKey };
}
