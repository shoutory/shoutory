import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Link, useNavigate, useRouteLoaderData } from "react-router";
import { z } from "zod";
import { ApiError, request } from "../http/client";
import { SESSION_ROUTE_ID, type Session } from "../session/session";
import { Button } from "../ui/button";
import { DirText } from "../ui/dir-text";
import { ErrorPanel } from "../ui/error-panel";
import { forgetWorkspace } from "./last-workspace";
import { useOnline } from "./offline-banner";

export function AccountMenu() {
  const { t } = useLingui();
  const session = useRouteLoaderData<Session>(SESSION_ROUTE_ID);
  const online = useOnline();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  // No guard against a second press or being offline: an aria-disabled Button passes no handler on.
  async function signOut() {
    setSigningOut(true);
    setFailure(null);
    let signedOut = true;
    try {
      await request(z.object({ success: z.boolean() }), "/api/auth/sign-out", {
        method: "POST",
        body: {},
        envelope: false,
      });
    } catch (error) {
      // An ended session is already signed out; anything else keeps the user in and says so.
      if (!(error instanceof ApiError)) throw error;
      signedOut = error.state === "session_expired";
      if (!signedOut) setFailure(error);
    } finally {
      setSigningOut(false);
    }
    if (signedOut) {
      forgetWorkspace();
      await navigate("/sign-in");
    }
  }

  const unavailable = signingOut || !online;
  const reason = signingOut
    ? t({ id: "shell.signing_out", message: "Signing out" })
    : t({ id: "shell.sign_out_offline", message: "You are offline. Signing out needs the server." });
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button>
        <Trans id="shell.account">Account</Trans>
      </Button>
      <Popover className="rounded-md border border-border bg-surface p-5 shadow-lg">
        <Dialog
          aria-label={t({ id: "shell.account", message: "Account" })}
          className="flex flex-col gap-3 outline-none"
        >
          {session ? <DirText dir="ltr">{session.user.email}</DirText> : null}
          <Link to="/account/profile" onClick={() => setOpen(false)} className="text-link underline">
            <Trans id="shell.profile">Profile</Trans>
          </Link>
          <Link to="/account/security" onClick={() => setOpen(false)} className="text-link underline">
            <Trans id="shell.security">Security</Trans>
          </Link>
          <Link to="/about" onClick={() => setOpen(false)} className="text-link underline">
            <Trans id="system.about.link">About Shoutory</Trans>
          </Link>
          <Button
            aria-disabled={unavailable}
            busy={signingOut}
            {...(unavailable ? { reason } : {})}
            onPress={signOut}
          >
            <Trans id="shell.sign_out">Sign out</Trans>
          </Button>
          {failure ? (
            <ErrorPanel
              what={<Trans id="shell.sign_out_failed.what">We could not sign you out</Trans>}
              meaning={<Trans id="shell.sign_out_failed.meaning">You are still signed in.</Trans>}
              error={failure}
            />
          ) : null}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
