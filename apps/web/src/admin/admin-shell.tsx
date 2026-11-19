import { Trans, useLingui } from "@lingui/react/macro";
import { NavLink, Outlet, useRevalidator } from "react-router";
import { authCopy } from "../auth/auth-copy";
import { ApiError } from "../http/client";
import { NotFoundPage } from "../pages/system-pages";
import { useShellData } from "../shell/shell-data";
import { ErrorPanel } from "../ui/error-panel";

const NAV_LINK = "min-h-6 pointer-coarse:min-h-11 text-link underline";

/**
 * The frame of the operator screens: a nav of the screens that exist, then the screen. They exist only for an
 * instance admin. A yes shows the frame and a no shows the not-found page (the server answers 404 to the same calls);
 * no answer (the admin read or a shell list failed) is neither: it shows the error panel, and Retry reads the shell
 * again.
 */
export function AdminShell() {
  const data = useShellData();
  const { t } = useLingui();
  const revalidator = useRevalidator();
  const failure = "error" in data ? data.error : data.admin instanceof ApiError ? data.admin : undefined;
  if (failure)
    return (
      <ErrorPanel
        error={failure}
        onRetry={() => void revalidator.revalidate()}
        {...authCopy("link", failure)}
      />
    );
  if ("error" in data || data.admin !== true) return <NotFoundPage />;
  return (
    <>
      <nav
        aria-label={t({ id: "admin.nav_label", message: "Admin sections" })}
        className="flex flex-wrap gap-5"
      >
        <NavLink to="/admin/flags" className={NAV_LINK}>
          <Trans id="admin.nav.flags">Feature flags</Trans>
        </NavLink>
        <NavLink to="/admin/signup" className={NAV_LINK}>
          <Trans id="admin.nav.signup">Sign-up</Trans>
        </NavLink>
        <NavLink to="/admin/providers" className={NAV_LINK}>
          <Trans id="admin.nav.providers">Provider apps</Trans>
        </NavLink>
      </nav>
      <Outlet />
    </>
  );
}
