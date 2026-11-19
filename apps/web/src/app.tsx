import { Trans } from "@lingui/react/macro";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router";

function NotFound() {
  return (
    <main id="main">
      <h1>
        <Trans id="system.not_found.title">Page not found</Trans>
      </h1>
      <p>
        <Trans id="system.not_found.body">We could not find the page you asked for.</Trans>
      </p>
    </main>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Outlet />,
    children: [{ path: "*", element: <NotFound /> }],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
