import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useRouteLoaderData } from "react-router";
import { readZone } from "../account/prefs";
import { ApiError } from "../http/client";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { ErrorPanel } from "../ui/error-panel";
import { LocalizedDateTime } from "../ui/localized";
import { peekSession, readSession, SESSION_ROUTE_ID, type Session } from "./session";

const LEAD_MS = 5 * 60_000;
// A browser timer longer than about 24.8 days fires at once, so a far end is waited for one day at a time.
const STEP_MS = 24 * 60 * 60_000;

type Phase = "waiting" | "warning" | "capped" | "closed";

const endOf = (found: Session) => Date.parse(found.session.expiresAt);
const movedPastLead = (end: number) => end - LEAD_MS > Date.now();

function useHere() {
  const location = useLocation();
  return location.pathname + location.search;
}

// An ended session goes to its own page; any other refusal is the caller's to show, and anything else is a bug.
function useSettle() {
  const navigate = useNavigate();
  const here = useHere();
  // The timer keeps the function of an earlier render, so the page is read when the session is found ended.
  const latest = useRef(here);
  latest.current = here;
  return async (error: unknown): Promise<void> => {
    if (!(error instanceof ApiError)) throw error;
    if (error.state !== "session_expired") return;
    await navigate(`/session-expired?return-to=${encodeURIComponent(latest.current)}`);
  };
}

// Calls `onLead` once the end is inside the lead time; a new `end` or a renewed `active` waits again.
function useLeadTimer(end: number, active: boolean, onLead: () => void) {
  const [step, setStep] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `step` waits the next day; `onLead` reads the page through a ref.
  useEffect(() => {
    if (!active || Number.isNaN(end)) return;
    const wait = end - LEAD_MS - Date.now();
    const timer = setTimeout(
      () => (wait > STEP_MS ? setStep((count) => count + 1) : onLead()),
      Math.max(0, Math.min(wait, STEP_MS)),
    );
    return () => clearTimeout(timer);
  }, [end, active, step]);
}

function useEndingSession() {
  const loaded = useRouteLoaderData<Session>(SESSION_ROUTE_ID);
  const settle = useSettle();
  const [end, setEnd] = useState(() => (loaded ? endOf(loaded) : Number.NaN));
  const [phase, setPhase] = useState<Phase>("waiting");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  useLeadTimer(end, phase === "waiting", async () => {
    try {
      const next = endOf(await peekSession());
      setEnd(next);
      if (!movedPastLead(next)) setPhase("warning");
    } catch (error) {
      await settle(error);
      setPhase("warning");
    }
  });

  async function stay() {
    setBusy(true);
    setFailure(null);
    try {
      const next = endOf(await readSession());
      setEnd(next);
      setPhase(movedPastLead(next) ? "waiting" : "capped");
    } catch (error) {
      await settle(error);
      if (error instanceof ApiError) setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  return { end, phase, busy, failure, stay, close: () => setPhase("closed") };
}

export function SessionEnd() {
  const { end, phase, busy, failure, stay, close } = useEndingSession();
  return (
    <Dialog
      role="alertdialog"
      title={<Trans id="session.end.title">Your session is about to end</Trans>}
      isOpen={phase === "warning" || phase === "capped"}
      onOpenChange={(open) => (open ? undefined : close())}
      locked={busy}
    >
      <SessionEndBody end={end} capped={phase === "capped"} />
      {failure ? (
        <ErrorPanel
          what={<Trans id="session.end.failed.what">We could not keep you signed in</Trans>}
          meaning={<Trans id="session.end.failed.meaning">Your session still ends at the time above.</Trans>}
          error={failure}
        />
      ) : null}
      <SessionEndActions capped={phase === "capped"} busy={busy} onStay={stay} onClose={close} />
    </Dialog>
  );
}

function SessionEndBody({ end, capped }: { end: number; capped: boolean }) {
  const at = <LocalizedDateTime value={new Date(end)} timeZone={readZone()} />;
  if (capped) {
    return (
      <p>
        <Trans id="session.end.capped">
          You will be signed out at {at}, and this session cannot be extended. Save your work, then sign in
          again.
        </Trans>
      </p>
    );
  }
  return (
    <p>
      <Trans id="session.end.body">
        You will be signed out at {at}. Changes you have not saved are not kept.
      </Trans>
    </p>
  );
}

function SessionEndActions({
  capped,
  busy,
  onStay,
  onClose,
}: {
  capped: boolean;
  busy: boolean;
  onStay: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const here = useHere();
  return (
    <div className="flex flex-wrap gap-3">
      {capped ? (
        <Link
          to={`/sign-in?return-to=${encodeURIComponent(here)}`}
          className="inline-flex min-h-10 items-center text-link underline"
        >
          <Trans id="session.end.sign_in">Sign in again</Trans>
        </Link>
      ) : (
        <Button
          busy={busy}
          aria-disabled={busy}
          {...(busy ? { reason: t({ id: "session.end.staying", message: "Keeping you signed in" }) } : {})}
          onPress={onStay}
        >
          <Trans id="session.end.stay">Stay signed in</Trans>
        </Button>
      )}
      <Button onPress={onClose} aria-disabled={busy}>
        <Trans id="session.end.close">Close</Trans>
      </Button>
    </div>
  );
}
