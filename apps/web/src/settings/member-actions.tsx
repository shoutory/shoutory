import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useRevalidator } from "react-router";
import type { Loaded } from "../account/use-load";
import { authCopy } from "../auth/auth-copy";
import { useAction } from "../auth/auth-frame";
import type { ApiError } from "../http/client";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { ErrorPanel } from "../ui/error-panel";

type Words = { what: ReactNode; meaning: ReactNode };

/**
 * One change to a workspace's people (a role, a removal, an invitation): it ignores a second press while it runs, an
 * ended session goes to sign-in and back, and a refused rank reads the shell lists again, so the page shows the role
 * the person has now (`onFailure` reads the page's own lists).
 */
export function useChange(run: () => Promise<void>, onFailure?: (error: ApiError) => void) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const { pathname } = useLocation();
  return useAction(run, (error) => {
    if (error.state === "session_expired")
      void navigate(`/sign-in?return-to=${encodeURIComponent(pathname)}`);
    if (error.state === "forbidden") void revalidator.revalidate();
    onFailure?.(error);
  });
}

/** A heading that takes focus when `move` is called: after a change ends the question, focus is not lost with it. */
export function useHeadingFocus() {
  const ref = useRef<HTMLHeadingElement>(null);
  const [moved, setMoved] = useState(0);
  useEffect(() => {
    if (moved > 0) ref.current?.focus();
  }, [moved]);
  return { ref, move: () => setMoved((now) => now + 1) };
}

/** One loaded list: the loading status, the error panel with Retry, or the list itself. */
export function Listed<T>({
  state,
  reload,
  children,
}: {
  state: Loaded<T>;
  reload: () => void;
  children: (data: T) => ReactNode;
}) {
  if (state.status === "loading")
    return (
      <p role="status">
        <Trans id="system.loading">Loading</Trans>
      </p>
    );
  if (state.status === "failed")
    return (
      <ErrorPanel focusOnMount error={state.error} onRetry={reload} {...authCopy("link", state.error)} />
    );
  return <>{children(state.data)}</>;
}

/**
 * A question before a change that ends something (a removal, a leave, a revoke): the dialog says what ends, nothing is
 * sent until the person confirms, and a refusal is shown inside it. A password that was not confirmed ends the
 * question and `onDeclined` tells the page; `onDone` runs once the dialog has closed after an answer.
 */
export function ConfirmChange({
  title,
  label,
  children,
  isOpen,
  onClose,
  run,
  onDone,
  onDeclined,
  onFailure,
  copyFor,
}: {
  title: ReactNode;
  label: ReactNode;
  children: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  run: () => Promise<void>;
  onDone?: () => void;
  onDeclined?: (error: ApiError) => void;
  onFailure?: (error: ApiError) => void;
  copyFor?: (error: ApiError) => Words | undefined;
}) {
  const action = useChange(
    async () => {
      await run();
      onClose();
      onDone?.();
    },
    (error) => {
      onFailure?.(error);
      if (error.code !== "step_up_required") return;
      onClose();
      onDeclined?.(error);
    },
  );
  // Closed, the question forgets its last refusal: the next time it opens it is a clean one.
  const { reset } = action;
  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen, reset]);
  return (
    <Dialog title={title} isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <div className="flex flex-col gap-5">
        <p>{children}</p>
        {action.failure ? (
          <ErrorPanel
            focusOnMount
            error={action.failure}
            {...(copyFor?.(action.failure) ?? changeCopy(action.failure))}
          />
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button
            busy={action.pending}
            aria-disabled={action.pending || !action.online}
            onPress={() => void action.run()}
          >
            {label}
          </Button>
          <Button aria-disabled={action.pending} onPress={onClose}>
            <Trans id="members.dismiss">Not now</Trans>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// Refusals the page does not offer but a stale page or a second tab can reach: each says what it means.
const BY_REASON: Record<string, Words> = {
  last_owner: {
    what: <Trans id="members.last_owner.what">A workspace needs one Owner</Trans>,
    meaning: (
      <Trans id="members.last_owner.meaning">
        The last Owner cannot leave or be changed. Nothing was changed.
      </Trans>
    ),
  },
  already_owner: {
    what: <Trans id="members.already_owner.what">That person is already the Owner</Trans>,
    meaning: <Trans id="members.already_owner.meaning">Nothing was changed.</Trans>,
  },
  use_leave: {
    what: <Trans id="members.use_leave.what">Use Leave workspace to remove yourself</Trans>,
    meaning: <Trans id="members.use_leave.meaning">Removing yourself is leaving. Nothing was changed.</Trans>,
  },
};

/** The words of a refused change: a password that was not confirmed, a refused rank and each reason have their own. */
export function changeCopy(error: ApiError): Words {
  const own = BY_REASON[error.details?.reason ?? ""];
  if (own) return own;
  if (error.code === "step_up_required")
    return {
      what: <Trans id="members.not_confirmed.what">Your password was not confirmed</Trans>,
      meaning: <Trans id="members.not_confirmed.meaning">Nothing was changed.</Trans>,
    };
  if (error.state === "forbidden")
    return {
      what: <Trans id="members.forbidden.what">You cannot make that change</Trans>,
      meaning: <Trans id="members.forbidden.meaning">Your role may have changed. Nothing was changed.</Trans>,
    };
  return authCopy("link", error);
}
