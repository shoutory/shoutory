import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type ReactElement, useEffect, useState } from "react";
import { Outlet, type Params, type RouteObject, replace, useMatches, useRouteError } from "react-router";
import { ProfilePage } from "./account/profile";
import { SecurityPage } from "./account/security";
import { AdminShell } from "./admin/admin-shell";
import { FlagsPage } from "./admin/flags";
import { ProvidersPage } from "./admin/providers";
import { QueuePage } from "./admin/queue";
import { ReleasesPage } from "./admin/releases";
import { SignupSwitchPage } from "./admin/signup-switch";
import { SystemPage } from "./admin/system";
import { ForgotPage } from "./auth/forgot";
import { InvitePage, inviteLoader } from "./auth/invite";
import { MfaPage } from "./auth/mfa";
import { ResetPage } from "./auth/reset";
import { SignInPage } from "./auth/sign-in";
import { SignUpPage } from "./auth/sign-up";
import { StepUpProvider } from "./auth/step-up";
import { TwoFactorSetupPage } from "./auth/two-factor-setup";
import { VerifyPage } from "./auth/verify";
import { BillingPage } from "./billing/billing";
import { ChannelDetailPage } from "./features/channels/channel-detail";
import { ChannelsHubPage } from "./features/channels/channels-hub";
import { ConnectResultPage } from "./features/channels/connect-result";
import { ComposerPage } from "./features/composer/composer";
import { MediaDetailPage } from "./features/media/media-detail";
import { MediaLibraryPage } from "./features/media/media-library";
import { NotificationsPage } from "./features/notifications/notifications";
import { PostsPage } from "./features/posts/posts-list";
import { ApiError } from "./http/client";
import { ClientsPage } from "./org/clients";
import { type PageHandle, usePageTitleAndFocus } from "./page-title";
import { AboutPage } from "./pages/about";
import {
  ForbiddenPage,
  MaintenancePage,
  NotFoundPage,
  SessionExpiredPage,
  StartupFailurePage,
} from "./pages/system-pages";
import { SESSION_ROUTE_ID, sessionGuard } from "./session/session";
import { SessionEnd } from "./session/session-end";
import { GeneralPage } from "./settings/general";
import { MembersPage } from "./settings/members";
import { Shell, StartPage, WorkspaceHome } from "./shell/shell";
import {
  isUnknownOrganization,
  isUnknownWorkspace,
  SHELL_ROUTE_ID,
  type ShellData,
  shellLoader,
} from "./shell/shell-data";
import { Button } from "./ui/button";

const TITLES = {
  signIn: msg({ id: "system.sign_in.title", message: "Sign in" }),
  about: msg({ id: "system.about.title", message: "About Shoutory" }),
  mfa: msg({ id: "auth.mfa.title", message: "Two-step verification" }),
  twoFactorSetup: msg({ id: "auth.setup.title", message: "Set up two-step verification" }),
  profile: msg({ id: "account.profile.title", message: "Profile" }),
  security: msg({ id: "account.security.title", message: "Security" }),
  invite: msg({ id: "auth.invite.title", message: "Accept your invitation" }),
  signUp: msg({ id: "auth.sign_up.title", message: "Create your account" }),
  forgot: msg({ id: "auth.forgot.title", message: "Reset your password" }),
  verify: msg({ id: "auth.verify.title", message: "Confirm your email" }),
  reset: msg({ id: "auth.reset.title", message: "Choose a new password" }),
  sessionExpired: msg({ id: "system.session_expired.title", message: "Your session has ended" }),
  notFound: msg({ id: "system.not_found.title", message: "Page not found" }),
  workspace: msg({ id: "shell.workspace.title", message: "Workspace" }),
  channels: msg({ id: "channels.hub.title", message: "Channels" }),
  channel: msg({ id: "channels.detail.title", message: "Channel" }),
  notices: msg({ id: "notices.title", message: "Notifications" }),
  posts: msg({ id: "posts.title", message: "Posts" }),
  media: msg({ id: "media.title", message: "Media" }),
  composerNew: msg({ id: "composer.title", message: "New post" }),
  composerEdit: msg({ id: "composer.edit.title", message: "Edit post" }),
  connectResult: msg({ id: "connect.result.title", message: "Connection result" }),
  clients: msg({ id: "org.clients.title", message: "Clients" }),
  general: msg({ id: "settings.general.title", message: "General" }),
  billing: msg({ id: "billing.title", message: "Billing" }),
  members: msg({ id: "members.title", message: "Members" }),
  admin: msg({ id: "admin.title", message: "Admin" }),
  adminFlags: msg({ id: "admin.flags.title", message: "Feature flags" }),
  adminQueue: msg({ id: "admin.queue.title", message: "Queue health" }),
  adminSystem: msg({ id: "admin.system.title", message: "Mail and storage" }),
  adminReleases: msg({ id: "admin.releases.title", message: "Releases" }),
  adminProviders: msg({ id: "admin.providers.title", message: "Provider apps" }),
  adminSignup: msg({ id: "admin.signup.title", message: "Sign-up" }),
  forbidden: msg({ id: "system.forbidden.title", message: "You do not have access to this page" }),
  maintenance: msg({ id: "system.maintenance.title", message: "Shoutory is not reachable right now" }),
  startupFailure: msg({ id: "system.startup_failure.title", message: "Shoutory did not start correctly" }),
};
const handle = (title: MessageDescriptor): PageHandle => ({ title });

// An id that is none of mine shows the not-found page, so the page is titled as one.
const titled = (
  title: MessageDescriptor,
  unknown: (shell: ShellData, params: Params) => boolean,
): PageHandle => ({
  title: (matches) => {
    const shell = matches.find((match) => match.id === SHELL_ROUTE_ID)?.loaderData as ShellData | undefined;
    return shell && unknown(shell, matches.at(-1)?.params ?? {}) ? TITLES.notFound : title;
  },
});

// The system page for a failed call, chosen from its typed state (only a 503 or a network failure is
// maintenance). Anything else that fails while the page loads is the start-up failure page.
function errorPage(error: unknown): { title: MessageDescriptor; page: ReactElement } {
  const state = error instanceof ApiError ? error.state : "error";
  switch (state) {
    case "maintenance":
      return { title: TITLES.maintenance, page: <MaintenancePage /> };
    case "forbidden":
      return { title: TITLES.forbidden, page: <ForbiddenPage /> };
    case "not_found":
      return { title: TITLES.notFound, page: <NotFoundPage /> };
    case "session_expired":
      return { title: TITLES.sessionExpired, page: <SessionExpiredPage /> };
    default:
      return {
        title: TITLES.startupFailure,
        page: <StartupFailurePage requestId={error instanceof ApiError ? error.requestId : undefined} />,
      };
  }
}

function RouteError() {
  const { title, page } = errorPage(useRouteError());
  usePageTitleAndFocus(title);
  return page;
}

function Root() {
  const matches = useMatches();
  usePageTitleAndFocus(
    matches
      .map((match) => {
        const title = (match.handle as PageHandle | undefined)?.title;
        return typeof title === "function" ? title(matches) : title;
      })
      .findLast(Boolean),
  );
  return (
    <StepUpProvider>
      <Outlet />
    </StepUpProvider>
  );
}

const SKELETON_DELAY_MS = 300;
const STILL_LOADING_MS = 10_000;

function Pending() {
  const [stage, setStage] = useState<"quiet" | "loading" | "slow">("quiet");
  useEffect(() => {
    const first = setTimeout(() => setStage("loading"), SKELETON_DELAY_MS);
    const second = setTimeout(() => setStage("slow"), STILL_LOADING_MS);
    return () => {
      clearTimeout(first);
      clearTimeout(second);
    };
  }, []);
  return (
    <div role="status" aria-busy="true" className="flex flex-col items-start gap-3 px-5 py-10">
      {stage === "loading" ? <Trans id="system.loading">Loading</Trans> : null}
      {stage === "slow" ? (
        <>
          <Trans id="shell.still_loading">Still loading</Trans>
          <Button onPress={() => window.location.reload()}>
            <Trans id="system.error.retry">Retry</Trans>
          </Button>
        </>
      ) : null}
    </div>
  );
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      // The auth pages are outside the session guard: a visitor with no session must be able to open them.
      { path: "sign-in", handle: handle(TITLES.signIn), element: <SignInPage /> },
      { path: "mfa", handle: handle(TITLES.mfa), element: <MfaPage /> },
      { path: "sign-up", handle: handle(TITLES.signUp), element: <SignUpPage /> },
      { path: "forgot", handle: handle(TITLES.forgot), element: <ForgotPage /> },
      // The mailed links open these two; the token is in the fragment, never the path.
      { path: "auth/verify", handle: handle(TITLES.verify), element: <VerifyPage /> },
      { path: "auth/reset", handle: handle(TITLES.reset), element: <ResetPage /> },
      // The mailed link points at /auth/sign-in.
      { path: "auth/sign-in", loader: () => replace("/sign-in") },
      // The invitation page reads the session itself: a signed-out visitor must see it, not be sent away.
      {
        path: "invite/:token",
        handle: handle(TITLES.invite),
        loader: inviteLoader,
        hydrateFallbackElement: <Pending />,
        element: <InvitePage />,
      },
      { path: "session-expired", handle: handle(TITLES.sessionExpired), element: <SessionExpiredPage /> },
      { path: "about", handle: handle(TITLES.about), element: <AboutPage /> },
      {
        id: SESSION_ROUTE_ID,
        loader: sessionGuard,
        element: (
          <>
            <Outlet />
            <SessionEnd />
          </>
        ),
        hydrateFallbackElement: <Pending />,
        children: [
          {
            id: SHELL_ROUTE_ID,
            loader: shellLoader,
            element: <Shell />,
            children: [
              { index: true, element: <StartPage /> },
              { path: "account/profile", handle: handle(TITLES.profile), element: <ProfilePage /> },
              { path: "account/security", handle: handle(TITLES.security), element: <SecurityPage /> },
              {
                path: "account/security/two-factor",
                handle: handle(TITLES.twoFactorSetup),
                element: <TwoFactorSetupPage />,
              },
              {
                path: "w/:ws/channels",
                handle: titled(TITLES.channels, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <ChannelsHubPage />,
              },
              {
                path: "w/:ws/channels/:channelId",
                handle: titled(TITLES.channel, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <ChannelDetailPage />,
              },
              {
                path: "w/:ws/posts",
                handle: titled(TITLES.posts, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <PostsPage />,
              },
              {
                path: "w/:ws/posts/new",
                handle: titled(TITLES.composerNew, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <ComposerPage />,
              },
              {
                path: "w/:ws/posts/:postId/edit",
                handle: titled(TITLES.composerEdit, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <ComposerPage />,
              },
              {
                path: "w/:ws/notifications",
                handle: titled(TITLES.notices, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <NotificationsPage />,
              },
              {
                path: "w/:ws/media",
                handle: titled(TITLES.media, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <MediaLibraryPage />,
              },
              {
                path: "w/:ws/media/:id",
                handle: titled(TITLES.media, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <MediaDetailPage />,
              },
              {
                path: "connect/result",
                handle: handle(TITLES.connectResult),
                element: <ConnectResultPage />,
              },
              {
                path: "w/:ws",
                handle: titled(TITLES.workspace, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <WorkspaceHome />,
              },
              {
                path: "admin",
                handle: titled(TITLES.admin, (shell) => !("error" in shell) && shell.admin === false),
                element: <AdminShell />,
                children: [
                  { index: true, loader: () => replace("/admin/flags") },
                  { path: "flags", handle: handle(TITLES.adminFlags), element: <FlagsPage /> },
                  { path: "queue", handle: handle(TITLES.adminQueue), element: <QueuePage /> },
                  { path: "system", handle: handle(TITLES.adminSystem), element: <SystemPage /> },
                  { path: "releases", handle: handle(TITLES.adminReleases), element: <ReleasesPage /> },
                  { path: "providers", handle: handle(TITLES.adminProviders), element: <ProvidersPage /> },
                  { path: "signup", handle: handle(TITLES.adminSignup), element: <SignupSwitchPage /> },
                ],
              },
              {
                path: "w/:ws/settings/general",
                handle: titled(TITLES.general, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <GeneralPage />,
              },
              {
                path: "w/:ws/settings/members",
                handle: titled(TITLES.members, (shell, params) => isUnknownWorkspace(shell, params.ws)),
                element: <MembersPage />,
              },
              {
                path: "o/:org/billing",
                handle: titled(TITLES.billing, (shell, params) => isUnknownOrganization(shell, params.org)),
                element: <BillingPage />,
              },
              {
                path: "o/:org/clients",
                handle: titled(TITLES.clients, (shell, params) => isUnknownOrganization(shell, params.org)),
                element: <ClientsPage />,
              },
            ],
          },
        ],
      },
      { path: "*", handle: handle(TITLES.notFound), element: <NotFoundPage /> },
    ],
  },
];
