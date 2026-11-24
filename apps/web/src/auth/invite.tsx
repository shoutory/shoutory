import { Trans } from "@lingui/react/macro";
import { type ReactNode, useState } from "react";
import { Form } from "react-aria-components";
import { Link, useLoaderData, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { ApiError, request } from "../http/client";
import { readSession, type Session } from "../session/session";
import { forgetWorkspace } from "../shell/last-workspace";
import { Button } from "../ui/button";
import { ErrorPanel } from "../ui/error-panel";
import { authCopy } from "./auth-copy";
import { AuthFrame, SubmitButton, useAction } from "./auth-frame";

// The token is 32 random bytes in base64url; anything else is never sent to the server.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const joined = z.object({ workspace_id: z.uuid() });
const status = z.object({ status: z.boolean() });
const signedOutAnswer = z.object({ success: z.boolean() });

// A visitor with no session sees the page, not a redirect.
export async function inviteLoader(): Promise<Session | null> {
  try {
    return await readSession();
  } catch (error) {
    if (error instanceof ApiError && error.state === "session_expired") return null;
    throw error;
  }
}

type Outcome = "expired" | "used" | "revoked" | "unknown" | "member" | "unverified" | "mismatch";

const BY_REASON: Record<string, Record<string, Outcome>> = {
  invitation_unusable: { expired: "expired", used: "used", revoked: "revoked" },
  conflict: { already_member: "member" },
  forbidden: { email_unverified: "unverified", email_mismatch: "mismatch" },
};

function outcomeOf(error: ApiError): Outcome | null {
  if (error.code === "not_found") return "unknown";
  const found = BY_REASON[error.code]?.[error.details?.reason ?? ""];
  return found ?? (error.code === "invitation_unusable" ? "unknown" : null);
}

const COPY: Record<Outcome, { what: ReactNode; meaning: ReactNode }> = {
  expired: {
    what: <Trans id="auth.invite.expired.what">This invitation has expired</Trans>,
    meaning: <Trans id="auth.invite.expired.meaning">An invitation stops working after a while.</Trans>,
  },
  used: {
    what: <Trans id="auth.invite.used.what">This invitation was already used</Trans>,
    meaning: <Trans id="auth.invite.used.meaning">Each invitation works once.</Trans>,
  },
  revoked: {
    what: <Trans id="auth.invite.revoked.what">This invitation was withdrawn</Trans>,
    meaning: <Trans id="auth.invite.revoked.meaning">The person who sent it cancelled it.</Trans>,
  },
  unknown: {
    what: <Trans id="auth.invite.unknown.what">We cannot find this invitation</Trans>,
    meaning: (
      <Trans id="auth.invite.unknown.meaning">
        The link may be incomplete. Check that you copied all of it.
      </Trans>
    ),
  },
  member: {
    what: <Trans id="auth.invite.member.what">You are already a member</Trans>,
    meaning: <Trans id="auth.invite.member.meaning">You can already open this workspace.</Trans>,
  },
  unverified: {
    what: <Trans id="auth.invite.unverified.what">Confirm your email first</Trans>,
    meaning: (
      <Trans id="auth.invite.unverified.meaning">
        Confirm your email, then open this invitation link again.
      </Trans>
    ),
  },
  mismatch: {
    what: <Trans id="auth.invite.mismatch.what">This invitation is for a different email</Trans>,
    meaning: (
      <Trans id="auth.invite.mismatch.meaning">
        You are signed in with another address. Sign out, then sign in with the address the invitation was
        sent to.
      </Trans>
    ),
  },
};
const ENDED: ReadonlySet<Outcome> = new Set(["expired", "used", "revoked", "unknown"]);

function ResendButton({ email }: { email: string }) {
  const [done, setDone] = useState(false);
  const resend = useAction(async () => {
    await request(status, "/api/auth/send-verification-email", {
      method: "POST",
      body: { email },
      envelope: false,
    });
    setDone(true);
  });
  return (
    <div className="flex flex-col items-start gap-2">
      <Button onPress={() => void resend.run()} busy={resend.pending} aria-disabled={resend.pending}>
        <Trans id="auth.verify.resend">Send a new link</Trans>
      </Button>
      {done ? (
        <p role="status">
          <Trans id="auth.verify.resent">If this address needs confirming, we sent a new link.</Trans>
        </p>
      ) : null}
      {resend.failure ? <ErrorPanel error={resend.failure} {...authCopy("link", resend.failure)} /> : null}
    </div>
  );
}

function SignOutButton({ path }: { path: string }) {
  const navigate = useNavigate();
  const signOut = useAction(async () => {
    try {
      await request(signedOutAnswer, "/api/auth/sign-out", { method: "POST", body: {}, envelope: false });
    } catch (error) {
      // An ended session is already signed out; anything else stays on the page and says so.
      if (!(error instanceof ApiError && error.state === "session_expired")) throw error;
    }
    forgetWorkspace();
    await navigate(`/sign-in?return-to=${encodeURIComponent(path)}`);
  });
  return (
    <div className="flex flex-col items-start gap-2">
      <Button onPress={() => void signOut.run()} busy={signOut.pending} aria-disabled={signOut.pending}>
        <Trans id="shell.sign_out">Sign out</Trans>
      </Button>
      {signOut.failure ? <ErrorPanel error={signOut.failure} {...authCopy("link", signOut.failure)} /> : null}
    </div>
  );
}

function Notice({ outcome, path, email }: { outcome: Outcome; path: string; email: string }) {
  const words = COPY[outcome];
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-xl">{words.what}</h2>
      <p>{words.meaning}</p>
      {ENDED.has(outcome) ? (
        <p>
          <Trans id="auth.invite.ask">Ask the person who invited you for a new invitation.</Trans>
        </p>
      ) : null}
      {outcome === "unverified" ? <ResendButton email={email} /> : null}
      {outcome === "mismatch" ? <SignOutButton path={path} /> : null}
      {outcome === "member" ? (
        <Link to="/" className="text-link underline">
          <Trans id="auth.setup.start">Go to the start page</Trans>
        </Link>
      ) : null}
    </section>
  );
}

function SignedOut({ path }: { path: string }) {
  return (
    <section className="flex flex-col gap-3">
      <p>
        <Trans id="auth.invite.signed_out">Sign in, or create an account, to accept this invitation.</Trans>
      </p>
      <p>
        <Trans id="auth.invite.after_sign_up">
          After you confirm your email, open the invitation link again.
        </Trans>
      </p>
      <div className="flex flex-wrap gap-5">
        <Link to={`/sign-in?return-to=${encodeURIComponent(path)}`} className="text-link underline">
          <Trans id="system.sign_in.title">Sign in</Trans>
        </Link>
        <Link to="/sign-up" className="text-link underline">
          <Trans id="auth.sign_up.submit">Create account</Trans>
        </Link>
      </div>
    </section>
  );
}

function AcceptForm({ token, onEnded }: { token: string; onEnded: (outcome: Outcome) => void }) {
  const navigate = useNavigate();
  const accept = useAction(
    async () => {
      const answer = await request(joined, "/api/v1/invitations/accept", { method: "POST", body: { token } });
      await navigate(`/w/${answer.workspace_id}`);
    },
    (error) => {
      const outcome = outcomeOf(error);
      if (outcome) onEnded(outcome);
      if (error.state === "session_expired") {
        void navigate(`/sign-in?return-to=${encodeURIComponent(`/invite/${token}`)}`);
      }
    },
  );
  const failure = accept.failure && !outcomeOf(accept.failure) ? accept.failure : null;
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void accept.run();
      }}
      className="flex flex-col gap-5"
    >
      <SubmitButton testId="invite-accept" pending={accept.pending} online={accept.online}>
        <Trans id="auth.invite.accept">Accept invitation</Trans>
      </SubmitButton>
      {failure ? <ErrorPanel focusOnMount error={failure} {...authCopy("link", failure)} /> : null}
    </Form>
  );
}

export function InvitePage() {
  const { token = "" } = useParams();
  return <InviteBody key={token} token={token} />;
}

function InviteBody({ token }: { token: string }) {
  const session = useLoaderData<Session | null>();
  const [outcome, setOutcome] = useState<Outcome | null>(TOKEN_SHAPE.test(token) ? null : "unknown");
  const path = `/invite/${token}`;
  let body: ReactNode;
  if (outcome) body = <Notice outcome={outcome} path={path} email={session?.user.email ?? ""} />;
  else if (!session) body = <SignedOut path={path} />;
  else body = <AcceptForm token={token} onEnded={setOutcome} />;
  return (
    <AuthFrame title={<Trans id="auth.invite.title">Accept your invitation</Trans>} step={outcome ?? "form"}>
      {body}
    </AuthFrame>
  );
}
