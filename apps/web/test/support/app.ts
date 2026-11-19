import { i18n, type Messages } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, type RouteObject, RouterProvider } from "react-router";
import { vi } from "vitest";
import { routes } from "../../src/routes";

// One harness for the screens under the shell: the real routes in a memory router, with the api answered per path.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const catalogs = import.meta.glob<{ messages: Messages }>("../../src/messages/*.po", { eager: true });

export interface Organization {
  id: string;
  name: string;
  slug: string;
  type: "agency" | "team" | "personal";
  org_role: "owner" | "admin" | "member";
}
export interface Workspace {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "editor" | "approver" | "viewer";
}

export const ORGS: Organization[] = [
  { id: "o1", name: "Acme Agency", slug: "acme", type: "agency", org_role: "owner" },
  { id: "o2", name: "Beta Team", slug: "beta", type: "team", org_role: "owner" },
];
export const WORKSPACES: Workspace[] = [
  { id: "w1", organization_id: "o1", name: "Acme One", slug: "acme-one", role: "owner" },
  { id: "w2", organization_id: "o1", name: "Acme Two", slug: "acme-two", role: "owner" },
  { id: "w3", organization_id: "o2", name: "Beta Main", slug: "beta-main", role: "owner" },
];

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const refusal = (code: string, status: number) =>
  json({ error: { code, message: "words the user must never see", requestId: "req-42" } }, status);
const page = (rows: unknown[]) => json({ data: rows, meta: { next_cursor: null } });

/** An answer that lists `rows` as one page. */
export const pageOf = (rows: unknown[]) => () => page(rows);
/** Lets pending calls and renders finish. */
export const settle = () => act(async () => undefined);

type Answer = () => Response | Promise<Response>;
export interface Api {
  session?: Answer;
  organizations?: Answer;
  workspaces?: Answer;
  signOut?: Answer;
  signIn?: Answer;
  verifyTotp?: Answer;
  verifyBackupCode?: Answer;
  verifyPassword?: Answer;
  resend?: Answer;
  signUpMode?: Answer;
  signUp?: Answer;
  verifyEmail?: Answer;
  requestReset?: Answer;
  resetPassword?: Answer;
  enable?: Answer;
  acceptInvitation?: Answer;
  profile?: Answer;
  createOrganization?: Answer;
  createWorkspace?: Answer;
  workspaceProfile?: Answer;
  patchWorkspace?: Answer;
  entitlements?: Answer;
  sessions?: Answer;
  revokeSession?: Answer;
  revokeOthers?: Answer;
  changePassword?: Answer;
  twoFactorStatus?: Answer;
  generateCodes?: Answer;
}

export const DEVICES = [
  {
    id: "s-here",
    createdAt: "2026-11-19T10:00:00.000Z",
    expiresAt: "2026-12-19T10:00:00.000Z",
    userAgent: "Mozilla/5.0 (Windows NT 10.0) Firefox/130.0",
    current: true,
  },
  {
    id: "s-phone",
    createdAt: "2026-11-18T08:00:00.000Z",
    expiresAt: "2026-12-18T08:00:00.000Z",
    userAgent: "Mozilla/5.0 (iPhone) Safari/604.1",
    current: false,
  },
  {
    id: "s-old",
    createdAt: "2026-11-01T08:00:00.000Z",
    expiresAt: "2026-12-01T08:00:00.000Z",
    userAgent: null,
    current: false,
  },
];

export const NEW_ORG = "0190a000-0000-7000-8000-0000000000a1";
export const NEW_WORKSPACE = "0190a000-0000-7000-8000-0000000000b1";

/** The profile of workspace w1 as GET and PATCH answer it. */
export const PROFILE = {
  id: "w1",
  organization_id: "o1",
  name: "Acme One",
  slug: "acme-one",
  colour: null,
  default_tz: "Africa/Cairo",
};

// The settings calls of workspace w1: its profile (read and changed) and its plan limits.
function settingsAnswers(api: Api): Record<string, Answer> {
  return {
    "/api/v1/workspaces/w1": api.workspaceProfile ?? (() => json({ data: PROFILE })),
    "/api/v1/workspaces/w1:PATCH": api.patchWorkspace ?? (() => json({ data: PROFILE })),
    "/api/v1/workspaces/w1/entitlements":
      api.entitlements ??
      (() => json({ data: { workspaces: { kind: "unlimited" }, members: { kind: "unlimited" } } })),
  };
}

// The create calls of the onboarding: an organization, then its first workspace (both answer 201 with the row).
function onboardingAnswers(api: Api): Record<string, Answer> {
  return {
    "/api/v1/organizations:POST":
      api.createOrganization ??
      (() => json({ data: { id: NEW_ORG, name: "New Org", slug: "o-new", type: "agency" } }, 201)),
    "/api/v1/workspaces:POST":
      api.createWorkspace ??
      (() =>
        json(
          {
            data: {
              id: NEW_WORKSPACE,
              organization_id: NEW_ORG,
              name: "New Client",
              slug: "new-client",
              colour: null,
              default_tz: "UTC",
            },
          },
          201,
        )),
  };
}

// The answers of the security page's calls (the sessions, the password change, the two-factor status and codes).
function securityAnswers(api: Api): Record<string, Answer> {
  return {
    ...onboardingAnswers(api),
    ...settingsAnswers(api),
    "/api/auth/sessions": api.sessions ?? (() => json({ data: DEVICES })),
    "/api/auth/sessions/revoke": api.revokeSession ?? (() => json({ data: { revoked: true } })),
    "/api/auth/sessions/revoke-others": api.revokeOthers ?? (() => json({ data: { revoked: true } })),
    "/api/auth/change-password": api.changePassword ?? (() => json({ user: USER })),
    "/api/auth/two-factor/status":
      api.twoFactorStatus ?? (() => json({ data: { enabled: false, recovery_codes_left: null } })),
    "/api/auth/two-factor/generate-backup-codes":
      api.generateCodes ?? (() => json({ status: true, backupCodes: [] })),
  };
}

export const USER = { id: "u1", name: "Person Sample", email: "person@example.test", emailVerified: true };

// The answers of the sign-up, link, setup, invitation and profile calls (the rest are in `stubApi`).
function moreAnswers(api: Api): Record<string, Answer> {
  return {
    "/api/auth/two-factor/enable":
      api.enable ?? (() => json({ method: "totp", totpURI: "", backupCodes: [] })),
    "/api/v1/invitations/accept":
      api.acceptInvitation ??
      (() => json({ data: { workspace_id: "0190a000-0000-7000-8000-000000000001" } })),
    "/api/auth/profile": api.profile ?? (() => json({ data: { name: "Person Sample" } })),
    "/api/v1/instance/signup": api.signUpMode ?? (() => json({ data: { open: true } })),
    "/api/auth/sign-up/email":
      api.signUp ?? (() => json({ user: { name: "T", email: "new@example.test", emailVerified: false } })),
    // The verify route answers in our envelope; the reset routes are library answers, bare.
    "/api/auth/verify-email": api.verifyEmail ?? (() => json({ data: { verified: true } })),
    "/api/auth/request-password-reset": api.requestReset ?? (() => json({ status: true })),
    "/api/auth/reset-password": api.resetPassword ?? (() => json({ status: true })),
  };
}

/** The fetch stub: each api path has its answer, signed in with `ORGS` and `WORKSPACES` unless a test says otherwise. */
export function stubApi(api: Api = {}) {
  const answers: Record<string, Answer> = {
    "/api/auth/get-session": api.session ?? (() => json(SESSION)),
    "/api/v1/organizations": api.organizations ?? (() => page(ORGS)),
    "/api/v1/workspaces": api.workspaces ?? (() => page(WORKSPACES)),
    "/api/auth/sign-out": api.signOut ?? (() => json({ success: true })),
    // The library-forwarded answers are bare: no `{data}` envelope.
    "/api/auth/sign-in/email": api.signIn ?? (() => json({ user: USER })),
    "/api/auth/two-factor/verify-totp": api.verifyTotp ?? (() => json({ user: USER })),
    "/api/auth/two-factor/verify-backup-code": api.verifyBackupCode ?? (() => json({ user: USER })),
    "/api/auth/verify-password": api.verifyPassword ?? (() => json({ status: true })),
    "/api/auth/send-verification-email": api.resend ?? (() => json({ status: true })),
    ...moreAnswers(api),
    ...securityAnswers(api),
  };
  const stub = vi.fn((path: string, init?: RequestInit) => {
    const pathname = new URL(path, "http://same-origin.invalid").pathname;
    // A create call to a path that also lists (organizations, workspaces) has its own `<path>:POST` answer.
    const answer = answers[`${pathname}:${init?.method ?? "GET"}`] ?? answers[pathname];
    return Promise.resolve(answer ? answer() : refusal("not_found", 404));
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

export const SESSION = {
  data: {
    session: { id: "s1", expiresAt: "2026-12-01T00:00:00Z" },
    user: { id: "u1", name: "Person Sample", email: "person@example.test", emailVerified: true },
  },
};

let root: Root | undefined;

/** Opens the real routes at `path` in `locale`; the stub must be set first (`stubApi`). */
export async function openApp(path: string, locale: "en" | "ar" = "en") {
  i18n.load(locale, catalogs[`../../src/messages/${locale}.po`]?.messages ?? {});
  i18n.activate(locale);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(I18nProvider, { i18n }, createElement(RouterProvider, { router })));
  });
  return { router, host };
}

/** Opens some routes of the test's own (a provider or a component under test) in a memory router. */
export async function mountRouted(routeObjects: RouteObject[], path: string, locale: "en" | "ar" = "en") {
  i18n.load(locale, catalogs[`../../src/messages/${locale}.po`]?.messages ?? {});
  i18n.activate(locale);
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(I18nProvider, { i18n }, createElement(RouterProvider, { router })));
  });
  return { router, host };
}

/** Renders one element under the i18n provider (the kit parts need no router or api). */
export function mount(element: React.ReactElement, locale: "en" | "ar" = "en") {
  i18n.load(locale, catalogs[`../../src/messages/${locale}.po`]?.messages ?? {});
  i18n.activate(locale);
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root?.render(createElement(I18nProvider, { i18n }, element)));
  return host;
}

export function closeApp() {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

export const WORKSPACE_KEY = "shoutory.workspace";

/** The first button, link or menu item whose text contains `text`. */
export function byText<T extends Element = HTMLElement>(host: ParentNode, selector: string, text: string) {
  const found = [...host.querySelectorAll<T>(selector)].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`no ${selector} with the text "${text}"`);
  return found;
}

/** The search box of the switcher whose label is `name`. */
export function combobox(host: ParentNode, name: string) {
  const input = [...host.querySelectorAll<HTMLInputElement>('input[role="combobox"]')].find((element) => {
    const label = (element.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id));
    return label.some((node) => node?.textContent?.includes(name));
  });
  if (!input) throw new Error(`no combobox named "${name}"`);
  return input;
}

/** Types into an input the way a user does, so React sees the change. */
export function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    input.focus();
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export const press = (element: Element, key: string, modifiers: KeyboardEventInit = {}) =>
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }),
    );
    element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...modifiers }));
  });

export const click = (element: HTMLElement) => act(() => element.click());
