import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { safeReturnTo } from "../session/return-to";
import { Button } from "../ui/button";
import { DirText } from "../ui/dir-text";

// The system pages (X-07). Each says what happened, what it means for the user's content and what to do (ux-spec 6.2);
// none shows a status code, a stack trace or the server's own words.
function Page({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <main id="main" className="mx-auto flex max-w-prose flex-col gap-5 px-5 py-10">
      <h1 className="font-heading text-2xl">{title}</h1>
      {children}
    </main>
  );
}

const ACTION = "text-link underline";

function HomeLink() {
  return (
    <Link to="/" className={ACTION}>
      <Trans id="system.action.home">Go to the start page</Trans>
    </Link>
  );
}

export function NotFoundPage() {
  return (
    <Page title={<Trans id="system.not_found.title">Page not found</Trans>}>
      <p>
        <Trans id="system.not_found.body">We could not find the page you asked for.</Trans>
      </p>
      <HomeLink />
    </Page>
  );
}

export function ForbiddenPage() {
  return (
    <Page title={<Trans id="system.forbidden.title">You do not have access to this page</Trans>}>
      <p>
        <Trans id="system.forbidden.body">
          Nothing was changed. Ask an owner or admin of the workspace to give you access.
        </Trans>
      </p>
      <HomeLink />
    </Page>
  );
}

export function SessionExpiredPage() {
  const [params] = useSearchParams();
  const back = encodeURIComponent(safeReturnTo(params.get("return-to")));
  return (
    <Page title={<Trans id="system.session_expired.title">Your session has ended</Trans>}>
      <p>
        <Trans id="system.session_expired.body">
          Changes you had not saved are not kept. Sign in again to continue where you were.
        </Trans>
      </p>
      <Link to={`/sign-in?return-to=${back}`} className={ACTION}>
        <Trans id="system.session_expired.action">Sign in again</Trans>
      </Link>
    </Page>
  );
}

export function MaintenancePage() {
  return (
    <Page title={<Trans id="system.maintenance.title">Shoutory is not reachable right now</Trans>}>
      <p>
        <Trans id="system.maintenance.body">
          Content you already saved is not affected. Wait a moment, then reload the page.
        </Trans>
      </p>
      <div>
        <Button onPress={() => window.location.reload()}>
          <Trans id="system.maintenance.action">Reload the page</Trans>
        </Button>
      </div>
    </Page>
  );
}

export function StartupFailurePage({ requestId }: { requestId?: string | undefined }) {
  return (
    <Page title={<Trans id="system.startup_failure.title">Shoutory did not start correctly</Trans>}>
      <p>
        <Trans id="system.startup_failure.body">
          The server answered with an error, so nothing was loaded and nothing was changed. If you run this
          server, check its logs; otherwise ask the person who does.
        </Trans>
      </p>
      {requestId ? (
        <details>
          <summary>
            <Trans id="system.startup_failure.details">Details</Trans>
          </summary>
          <Trans id="system.startup_failure.reference">Reference</Trans>{" "}
          <DirText dir="ltr">{requestId}</DirText>
        </details>
      ) : null}
    </Page>
  );
}

// Sign-in is built with the first form (A-01); until then the page says so, and its retry link goes back to the page
// the visitor asked for, which asks the guard again.
export function SignInPlaceholder() {
  const [params] = useSearchParams();
  return (
    <Page title={<Trans id="system.sign_in.title">Sign in</Trans>}>
      <p>
        <Trans id="system.sign_in.body">The sign-in form is not available in this version yet.</Trans>
      </p>
      <a href={safeReturnTo(params.get("return-to"))} className={ACTION}>
        <Trans id="system.sign_in.action">Try again</Trans>
      </a>
    </Page>
  );
}
