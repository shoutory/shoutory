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
export const refusal = (code: string, status: number, details?: Record<string, string>) =>
  json(
    {
      error: {
        code,
        message: "words the user must never see",
        requestId: "req-42",
        ...(details ? { details } : {}),
      },
    },
    status,
  );
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
  /** The members page of workspace w1: both lists, and each change (the id in the path is any member or invitation). */
  members?: Answer;
  invitations?: Answer;
  changeRole?: Answer;
  removeMember?: Answer;
  leave?: Answer;
  invite?: Answer;
  revokeInvitation?: Answer;
  /** The operator screens: whether the caller is an instance admin, the flags, the settings and their two writes. */
  admin?: Answer;
  adminFlags?: Answer;
  overrideFlag?: Answer;
  adminSettings?: Answer;
  setSignup?: Answer;
  adminQueue?: Answer;
  storageCheck?: Answer;
  mailCheck?: Answer;
  mailTest?: Answer;
  adminSystem?: Answer;
  /** The one-channel read of any workspace and any channel id (the connect result page reads it). */
  channel?: Answer;
}

/** Workspace and channel ids in the form the server writes (lower-case UUIDs); the older fixtures use `w1`. */
export const CONNECT_WS = "0190a000-0000-7000-8000-0000000000c1";
export const CONNECT_CHANNEL = "0190a000-0000-7000-8000-0000000000d1";
/** A workspace list whose one entry has a UUID id: what the connect result page matches its `workspace` against. */
export const uuidWorkspaces = () =>
  pageOf([
    { id: CONNECT_WS, organization_id: "o1", name: "Acme Connect", slug: "acme-connect", role: "owner" },
  ]);

/** A channel as the one-channel read answers it (the server's allowlist); `change` overrides fields. */
export const channelRow = (change: Record<string, unknown> = {}) => ({
  id: CONNECT_CHANNEL,
  provider_id: "fixture_oauth",
  account_kind: "profile",
  display_name: "Acme Page",
  handle: "@acme_page",
  nickname: null,
  avatar: null,
  connection_state: "connected",
  state_reason: null,
  health: "ok",
  health_checked_at: "2026-11-22T10:00:00.000Z",
  token_expires_at: null,
  reconnect_deadline: null,
  capability_epoch: 0,
  actions: ["check"],
  ...change,
});

// The one-channel read: any workspace id and any channel id in the path.
function channelAnswers(api: Api, pathname: string, method: string): Answer | undefined {
  const matches = /^\/api\/v1\/workspaces\/[^/]+\/channels\/[^/]+$/.test(pathname);
  return matches && method === "GET" ? (api.channel ?? (() => json({ data: channelRow() }))) : undefined;
}

/** The queue health of the instance: a running worker, a silent one, and the lag of the outbox and the job queue. */
export const QUEUE = {
  workers: [
    {
      worker_id: "worker-fresh",
      role: "worker",
      started_at: "2026-11-19T08:00:00Z",
      seen_at: "2026-11-19T10:00:00Z",
      stale: false,
    },
    {
      worker_id: "worker-silent",
      role: "all",
      started_at: "2026-11-18T08:00:00Z",
      seen_at: "2026-11-18T09:00:00Z",
      stale: true,
    },
  ],
  outbox_lag_seconds: 12,
  jobs: { installed: true, lag_seconds: 3 },
};

/** The release information: version, channel and the migrations applied against those shipped. */
export const SYSTEM = {
  version: "1.2.3",
  channel: "stable",
  migrations: { applied: 12, shipped: 12, pending: [] as string[] },
};

/** The flags of the instance as the admin list answers them: one off, one forced off, one past its removal date. */
export const FLAGS = [
  {
    key: "new-composer",
    description: "The new composer",
    owner: "core-team",
    remove_by: "2099-01-01",
    default_on: false,
    instance_override: null,
    effective: false,
  },
  {
    key: "dark-launch",
    description: "Dark launch",
    owner: "core-team",
    remove_by: "2099-01-01",
    default_on: true,
    instance_override: false,
    effective: false,
  },
  {
    key: "old-thing",
    description: "Past its date",
    owner: "core-team",
    remove_by: "2000-01-01",
    default_on: false,
    instance_override: null,
    effective: false,
  },
];

// The operator screens' calls; a flag key in the override path is any key.
function adminAnswers(api: Api, pathname: string, method: string): Answer | undefined {
  const route = pathname.replace(/\/flags\/[^/]+\/override$/, "/flags/*/override");
  const answers: Record<string, Answer> = {
    "/api/v1/instance/admin:GET": api.admin ?? (() => json({ data: { admin: false } })),
    "/api/v1/admin/flags:GET": api.adminFlags ?? (() => json({ data: FLAGS })),
    "/api/v1/admin/flags/*/override:PUT":
      api.overrideFlag ?? (() => json({ data: { key: "new-composer", on: true } })),
    "/api/v1/admin/settings:GET": api.adminSettings ?? (() => json({ data: [] })),
    "/api/v1/admin/queue:GET": api.adminQueue ?? (() => json({ data: QUEUE })),
    "/api/v1/admin/system:GET": api.adminSystem ?? (() => json({ data: SYSTEM })),
    "/api/v1/admin/storage/check:POST":
      api.storageCheck ??
      (() =>
        json({
          data: { driver: "fs", writable: true, readable: true, free_bytes: 1_000_000, failure: null },
        })),
    "/api/v1/admin/mail/check:POST":
      api.mailCheck ?? (() => json({ data: { domain: "mail.example.test", records: [] } })),
    "/api/v1/admin/mail/test:POST": api.mailTest ?? (() => json({ data: { queued: true } })),
    "/api/v1/admin/settings/signup_enabled:PUT":
      api.setSignup ?? (() => json({ data: { key: "signup_enabled", value: true } })),
  };
  return answers[`${route}:${method}`];
}

/** The members of w1 as the caller sees them: the others, plus the caller (u1) in `role`; below an Owner caller sits an Owner. */
export function membersFor(role: string) {
  const row = (id: string, name: string, as: string, status = "active") => ({
    user_id: id,
    name,
    image: null,
    role: as,
    status,
  });
  const others = [
    row("u2", "Admin Two", "admin"),
    row("u3", "Editor Three", "editor"),
    row("u4", "Viewer Four", "viewer"),
    row("u5", "Suspended Five", "editor", "suspended"),
  ];
  const self = row("u1", "Person Sample", role);
  return role === "owner" ? [self, ...others] : [row("u0", "Owner Zero", "owner"), self, ...others];
}
export const INVITATIONS = [
  { id: "i1", email: "pending@example.test", role_key: "editor", expires_at: "2099-11-21T10:00:00.000Z" },
  { id: "i2", email: "old@example.test", role_key: "viewer", expires_at: "2026-11-01T10:00:00.000Z" },
];

// The members and invitations calls of workspace w1; the changes to one member or invitation match by method.
function membersAnswers(api: Api, pathname: string, method: string): Answer | undefined {
  const base = "/api/v1/workspaces/w1";
  // A member or an invitation id in the path is any id: `*`.
  const route = pathname.replace(/\/(members|invitations)\/(?!me\/)[^/]+$/, "/$1/*");
  const answers: Record<string, Answer> = {
    [`${base}/members:GET`]: api.members ?? (() => page(membersFor("admin"))),
    [`${base}/invitations:GET`]: api.invitations ?? (() => page(INVITATIONS)),
    [`${base}/members/me/leave:POST`]: api.leave ?? (() => json({ data: null })),
    [`${base}/invitations:POST`]:
      api.invite ?? (() => json({ data: { id: "i3", email: "new@example.test", role_key: "viewer" } }, 201)),
    [`${base}/members/*:PATCH`]: api.changeRole ?? (() => json({ data: { user_id: "u3", role: "viewer" } })),
    [`${base}/members/*:DELETE`]: api.removeMember ?? (() => json({ data: null })),
    [`${base}/invitations/*:DELETE`]: api.revokeInvitation ?? (() => json({ data: null })),
  };
  return answers[`${route}:${method}`];
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
// What the server answers to a second-factor code: its allowlist has no id (apps/api auth paths).
const CHALLENGE_USER = { name: USER.name, email: USER.email, emailVerified: true };

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
    "/api/auth/two-factor/verify-totp": api.verifyTotp ?? (() => json({ user: CHALLENGE_USER })),
    "/api/auth/two-factor/verify-backup-code": api.verifyBackupCode ?? (() => json({ user: CHALLENGE_USER })),
    "/api/auth/verify-password": api.verifyPassword ?? (() => json({ status: true })),
    "/api/auth/send-verification-email": api.resend ?? (() => json({ status: true })),
    ...moreAnswers(api),
    ...securityAnswers(api),
  };
  const stub = vi.fn((path: string, init?: RequestInit) => {
    const pathname = new URL(path, "http://same-origin.invalid").pathname;
    // A create call to a path that also lists (organizations, workspaces) has its own `<path>:POST` answer.
    const method = init?.method ?? "GET";
    const answer =
      answers[`${pathname}:${method}`] ??
      answers[pathname] ??
      membersAnswers(api, pathname, method) ??
      channelAnswers(api, pathname, method) ??
      adminAnswers(api, pathname, method);
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

/** The workspace list with the caller's own role in w1 set to `role`. */
export const roleOf = (role: string) =>
  pageOf(WORKSPACES.map((workspace) => (workspace.id === "w1" ? { ...workspace, role } : workspace)));

/** The table row whose text contains `text`. */
export function rowOf(host: ParentNode, text: string) {
  const row = [...host.querySelectorAll<HTMLElement>("tr")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!row) throw new Error(`no row with the text "${text}"`);
  return row;
}

/** The trigger of the Select inside `scope` whose label contains `label`. */
export function selectTrigger(scope: ParentNode, label: string) {
  const trigger = [...scope.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]')].find((button) =>
    (button.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .some((id) => document.getElementById(id)?.textContent?.includes(label)),
  );
  if (!trigger) throw new Error(`no Select labelled "${label}"`);
  return trigger;
}

/** The texts of the options of the open list, in order. */
export const optionTexts = () =>
  [...document.body.querySelectorAll('[role="option"]')].map((option) => option.textContent);

/** Opens the Select labelled `label` in `scope` and chooses the option whose text is exactly `option`. */
export function pick(scope: ParentNode, label: string, option: string) {
  click(selectTrigger(scope, label));
  const found = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent === option,
  );
  if (!found) throw new Error(`no option "${option}"`);
  click(found);
}

/** Opens the members page of w1 as a caller whose role there is `role`; `api` overrides any answer. */
export async function openMembers(role: string, api: Api = {}) {
  const stub = stubApi({ workspaces: roleOf(role), members: pageOf(membersFor(role)), ...api });
  const opened = await openApp("/w/w1/settings/members");
  return { stub, ...opened };
}

/** Opens an operator screen as an instance admin (the shell's admin read answers true); `api` overrides any answer. */
export async function openAdmin(path: string, api: Api = {}) {
  const stub = stubApi({ admin: () => json({ data: { admin: true } }), ...api });
  const opened = await openApp(path);
  return { stub, ...opened };
}

/** A sensitive call that is refused with step_up_required until the password was verified, then answers `ok`. */
export function needsPassword(key: keyof Api, ok: () => Response): Api {
  let verified = false;
  return {
    [key]: () => (verified ? ok() : refusal("step_up_required", 403)),
    verifyPassword: () => {
      verified = true;
      return json({ status: true });
    },
  };
}

/** Types the password into the open password dialog and confirms. */
export async function confirmPassword() {
  const field = document.querySelector<HTMLInputElement>('[role="dialog"] input[name="password"]');
  if (!field) throw new Error("no password dialog is open");
  type(field, "correct horse battery 7");
  click(byText(document.body, '[role="dialog"] button', "Confirm"));
  await settle();
}

/** The calls to a path (a part of it) with a method. */
export const callsTo = (stub: ReturnType<typeof stubApi>, method: string, part: string) =>
  stub.mock.calls.filter(([url, init]) => url.includes(part) && (init?.method ?? "GET") === method);
