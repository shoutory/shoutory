import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { Outlet, type RouteObject, useRouteError } from "react-router";
import { ApiError } from "./http/client";
import {
  ForbiddenPage,
  MaintenancePage,
  NotFoundPage,
  SessionExpiredPage,
  SignInPlaceholder,
  StartupFailurePage,
} from "./pages/system-pages";
import { SESSION_ROUTE_ID, sessionGuard } from "./session/session";

// The system page for a failed call, chosen from its typed state (R382: only a 503 or a network failure is
// maintenance). Anything else that fails while the page loads is the start-up failure page.
function RouteError() {
  const error = useRouteError();
  if (!(error instanceof ApiError)) return <StartupFailurePage />;
  switch (error.state) {
    case "maintenance":
      return <MaintenancePage />;
    case "forbidden":
      return <ForbiddenPage />;
    case "not_found":
      return <NotFoundPage />;
    case "session_expired":
      return <SessionExpiredPage />;
    default:
      return <StartupFailurePage requestId={error.requestId} />;
  }
}

const SKELETON_DELAY_MS = 300;

// While the guard asks the server nothing shows for 300 ms (a fast answer never flashes), then a status line.
function Pending() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="status" aria-busy="true" className="px-5 py-10">
      {shown ? <Trans id="system.loading">Loading</Trans> : null}
    </div>
  );
}

// The signed-in screens are children of the guarded route; the shell and the first screens arrive with M0-11c.
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Outlet />,
    errorElement: <RouteError />,
    children: [
      { path: "sign-in", element: <SignInPlaceholder /> },
      { path: "session-expired", element: <SessionExpiredPage /> },
      {
        id: SESSION_ROUTE_ID,
        loader: sessionGuard,
        element: <Outlet />,
        hydrateFallbackElement: <Pending />,
        children: [{ index: true, element: <main id="main">Shoutory</main> }],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
