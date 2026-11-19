import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type ReactElement, useEffect, useState } from "react";
import { Outlet, type RouteObject, replace, useMatches, useRouteError } from "react-router";
import { ForgotPage } from "./auth/forgot";
import { MfaPage } from "./auth/mfa";
import { ResetPage } from "./auth/reset";
import { SignInPage } from "./auth/sign-in";
import { SignUpPage } from "./auth/sign-up";
import { StepUpProvider } from "./auth/step-up";
import { TwoFactorSetupPage } from "./auth/two-factor-setup";
import { VerifyPage } from "./auth/verify";
import { ApiError } from "./http/client";
import { type PageHandle, usePageTitleAndFocus } from "./page-title";
import {
  ForbiddenPage,
  MaintenancePage,
  NotFoundPage,
  SessionExpiredPage,
  StartupFailurePage,
} from "./pages/system-pages";
import { SESSION_ROUTE_ID, sessionGuard } from "./session/session";
import { Shell, StartPage, WorkspaceHome } from "./shell/shell";
import { isUnknownWorkspace, SHELL_ROUTE_ID, type ShellData, shellLoader } from "./shell/shell-data";
import { Button } from "./ui/button";

// The page names, in the words of each page's heading (system-pages.tsx).
const TITLES = {
  signIn: msg({ id: "system.sign_in.title", message: "Sign in" }),
  mfa: msg({ id: "auth.mfa.title", message: "Two-step verification" }),
  twoFactorSetup: msg({ id: "auth.setup.title", message: "Set up two-step verification" }),
  signUp: msg({ id: "auth.sign_up.title", message: "Create your account" }),
  forgot: msg({ id: "auth.forgot.title", message: "Reset your password" }),
  verify: msg({ id: "auth.verify.title", message: "Confirm your email" }),
  reset: msg({ id: "auth.reset.title", message: "Choose a new password" }),
  sessionExpired: msg({ id: "system.session_expired.title", message: "Your session has ended" }),
  notFound: msg({ id: "system.not_found.title", message: "Page not found" }),
  workspace: msg({ id: "shell.workspace.title", message: "Workspace" }),
  forbidden: msg({ id: "system.forbidden.title", message: "You do not have access to this page" }),
  maintenance: msg({ id: "system.maintenance.title", message: "Shoutory is not reachable right now" }),
  startupFailure: msg({ id: "system.startup_failure.title", message: "Shoutory did not start correctly" }),
};
const handle = (title: MessageDescriptor): PageHandle => ({ title });

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
  // The deepest matched route that names itself; a function decides from the loader data (the workspace route).
  usePageTitleAndFocus(
    matches
      .map((match) => {
        const title = (match.handle as PageHandle | undefined)?.title;
        return typeof title === "function" ? title(matches) : title;
      })
      .findLast(Boolean),
  );
  // The step-up dialog is one for the whole app: any screen's sensitive call may ask for the password (X-04).
  return (
    <StepUpProvider>
      <Outlet />
    </StepUpProvider>
  );
}

const SKELETON_DELAY_MS = 300;
const STILL_LOADING_MS = 10_000;

// While the server is asked: nothing for 300 ms (a fast answer never flashes), then a status line, and
// after 10 s "Still loading" with Retry.
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

// The signed-in screens sit in the shell, under the guard: `/` opens a workspace, `/w/:ws` is its scope.
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
      { path: "session-expired", handle: handle(TITLES.sessionExpired), element: <SessionExpiredPage /> },
      {
        id: SESSION_ROUTE_ID,
        loader: sessionGuard,
        element: <Outlet />,
        hydrateFallbackElement: <Pending />,
        children: [
          {
            id: SHELL_ROUTE_ID,
            loader: shellLoader,
            element: <Shell />,
            children: [
              { index: true, element: <StartPage /> },
              {
                path: "account/security/two-factor",
                handle: handle(TITLES.twoFactorSetup),
                element: <TwoFactorSetupPage />,
              },
              {
                path: "w/:ws",
                // An id that is none of mine shows the not-found page, so the page is titled as one.
                handle: {
                  title: (matches) => {
                    const shell = matches.find((match) => match.id === SHELL_ROUTE_ID)?.loaderData as
                      | ShellData
                      | undefined;
                    return shell && isUnknownWorkspace(shell, matches.at(-1)?.params.ws)
                      ? TITLES.notFound
                      : TITLES.workspace;
                  },
                } satisfies PageHandle,
                element: <WorkspaceHome />,
              },
            ],
          },
        ],
      },
      { path: "*", handle: handle(TITLES.notFound), element: <NotFoundPage /> },
    ],
  },
];
