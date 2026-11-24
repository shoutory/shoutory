import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect } from "react";
import { Link as AriaLink } from "react-aria-components";
import { Link, Navigate, NavLink, Outlet, useParams, useRevalidator, useSearchParams } from "react-router";
import { Onboarding } from "../onboarding/onboarding";
import { NotFoundPage } from "../pages/system-pages";
import { DirText } from "../ui/dir-text";
import { EmptyState } from "../ui/empty-state";
import { ErrorPanel } from "../ui/error-panel";
import { AccountMenu } from "./account-menu";
import { lastWorkspace, rememberWorkspace } from "./last-workspace";
import { OfflineBanner } from "./offline-banner";
import { useShellData } from "./shell-data";
import { Switchers } from "./switcher";

const HELP_URL = "https://docs.shoutory.com";

// The skip link moves focus into main itself: a hash change alone does not focus it in every browser.
const focusMain = () => document.getElementById("main")?.focus();

function TopBar() {
  const { t } = useLingui();
  const data = useShellData();
  const { revalidate } = useRevalidator();
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-5 py-3 lg:flex-nowrap">
      <span translate="no" className="font-heading text-lg">
        Shoutory
      </span>
      <div className="flex min-w-0 flex-[1_1_16rem] flex-wrap items-center gap-3 lg:flex-nowrap">
        {"error" in data ? (
          <ErrorPanel
            what={
              <Trans id="shell.lists_error.what">We could not load your organizations and workspaces</Trans>
            }
            meaning={
              <Trans id="shell.lists_error.meaning">
                Nothing was changed. The rest of the page still works.
              </Trans>
            }
            error={data.error}
            onRetry={() => void revalidate()}
          />
        ) : (
          <Switchers organizations={data.organizations} workspaces={data.workspaces} />
        )}
      </div>
      <a
        href={HELP_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t({ id: "shell.help_label", message: "Help (opens in a new tab)" })}
        className="min-h-6 pointer-coarse:min-h-11 text-link underline"
      >
        <Trans id="shell.help">Help</Trans>
      </a>
      <AccountMenu />
    </header>
  );
}

const NAV_LINK = "min-h-6 pointer-coarse:min-h-11 text-link underline";

function Rail() {
  const { ws, org } = useParams();
  const { t } = useLingui();
  const data = useShellData();
  const lists = "error" in data ? undefined : data;
  const orgId = org ?? lists?.workspaces.find((workspace) => workspace.id === ws)?.organization_id;
  const shared = lists?.organizations.some(
    (candidate) => candidate.id === orgId && candidate.type !== "personal",
  );
  return (
    <nav
      aria-label={t({ id: "shell.nav_label", message: "Main navigation" })}
      className="fixed inset-x-0 bottom-0 z-30 flex gap-3 border-t border-border bg-surface px-5 py-3 md:static md:flex-col md:border-t-0 md:border-e"
    >
      {ws ? (
        <NavLink to={`/w/${ws}`} end className={NAV_LINK}>
          <Trans id="shell.nav.home">Home</Trans>
        </NavLink>
      ) : null}
      {ws ? (
        <NavLink to={`/w/${ws}/channels`} className={NAV_LINK}>
          <Trans id="shell.nav.channels">Channels</Trans>
        </NavLink>
      ) : null}
      {shared ? (
        <NavLink to={`/o/${orgId}/clients`} className={NAV_LINK}>
          <Trans id="shell.nav.clients">Clients</Trans>
        </NavLink>
      ) : null}
      {shared ? (
        <NavLink to={`/o/${orgId}/billing`} className={NAV_LINK}>
          <Trans id="shell.nav.billing">Billing</Trans>
        </NavLink>
      ) : null}
      {ws && shared ? (
        <NavLink to={`/w/${ws}/settings/members`} className={NAV_LINK}>
          <Trans id="shell.nav.members">Members</Trans>
        </NavLink>
      ) : null}
      {lists?.admin === true ? (
        <NavLink to="/admin" className={NAV_LINK}>
          <Trans id="shell.nav.admin">Admin</Trans>
        </NavLink>
      ) : null}
      {ws ? (
        <NavLink to={`/w/${ws}/settings/general`} className={NAV_LINK}>
          <Trans id="shell.nav.settings">Settings</Trans>
        </NavLink>
      ) : null}
    </nav>
  );
}

export function Shell() {
  return (
    <div className="flex min-h-dvh flex-col md:grid md:grid-cols-[auto_1fr] md:grid-rows-[auto_1fr]">
      <AriaLink
        href="#main"
        onPress={focusMain}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-surface focus:p-3"
      >
        <Trans id="shell.skip">Skip to main content</Trans>
      </AriaLink>
      <div className="md:col-span-2">
        <TopBar />
      </div>
      <Rail />
      <main id="main" tabIndex={-1} className="flex flex-col gap-5 px-5 py-8 pb-20 outline-none md:pb-8">
        <OfflineBanner />
        <Outlet />
      </main>
    </div>
  );
}

const Welcome = () => (
  <h1 className="font-heading text-2xl">
    <Trans id="shell.welcome">Welcome to Shoutory</Trans>
  </h1>
);

function NoWorkspaces() {
  return (
    <>
      <Welcome />
      <EmptyState
        kind="first-use"
        title={<Trans id="shell.no_workspaces.title">You have no workspaces yet</Trans>}
      >
        <Trans id="shell.no_workspaces.body">
          A workspace holds the channels and posts of one client or brand.
        </Trans>
      </EmptyState>
    </>
  );
}

function AskAnAdmin() {
  return (
    <>
      <Welcome />
      <EmptyState
        kind="first-use"
        title={<Trans id="onboarding.member_title">You are not in a workspace yet</Trans>}
      >
        <Trans id="onboarding.member_body">Ask an admin to invite you, or start your own organization.</Trans>
      </EmptyState>
      <Link to="/?new=1" className="text-link underline">
        <Trans id="onboarding.start_own">Start your own organization</Trans>
      </Link>
    </>
  );
}

export function StartPage() {
  const data = useShellData();
  const [params] = useSearchParams();
  if ("error" in data) return <Welcome />;
  if (data.workspaces.length > 0) {
    const stored = lastWorkspace();
    const target = data.workspaces.find((workspace) => workspace.id === stored) ?? data.workspaces[0];
    return <Navigate to={`/w/${target?.id}`} replace />;
  }
  // An organization I own or administer with no workspace is always resumed, `?new` or not: a reload after a failed
  // workspace call must not start a second organization.
  const own = data.organizations.find((org) => org.org_role === "owner" || org.org_role === "admin");
  if (own || params.has("new") || data.organizations.length === 0) {
    return <Onboarding resume={own} focusHeading={params.has("new")} />;
  }
  return <AskAnAdmin />;
}

export function WorkspaceHome() {
  const { ws } = useParams();
  const data = useShellData();
  const current = "error" in data ? undefined : data.workspaces.find((workspace) => workspace.id === ws);
  useEffect(() => {
    if (current) rememberWorkspace(current.id);
  }, [current]);
  if ("error" in data) return <Welcome />;
  if (data.workspaces.length === 0) return <NoWorkspaces />;
  if (!current) return <NotFoundPage />;
  return (
    <>
      <h1 className="font-heading text-2xl" data-testid="workspace-name">
        <DirText>{current.name}</DirText>
      </h1>
      <EmptyState kind="first-use" title={<Trans id="shell.workspace.empty_title">Nothing here yet</Trans>}>
        <Trans id="shell.workspace.empty_body">
          The screens for this workspace are not available in this version yet.
        </Trans>
      </EmptyState>
    </>
  );
}
