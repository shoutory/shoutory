import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef } from "react";
import type { ApiError } from "../http/client";
import { Button } from "./button";
import { DirText } from "./dir-text";

// Trying again can help when the server or the network was unavailable; a refusal of the call will answer the same.
const SERVER_ERROR = 500;
const isRetryable = (error: ApiError) =>
  error.state === "maintenance" || (error.state === "error" && error.status >= SERVER_ERROR);

function CopyReference({ id }: { id: string }) {
  if (!navigator.clipboard) return null;
  const copy = () => {
    navigator.clipboard.writeText(id).catch((error: unknown) => {
      // A refused clipboard permission is a normal answer: the id stays on screen to be copied by hand.
      if (!(error instanceof DOMException)) throw error;
    });
  };
  return (
    <Button onPress={copy}>
      <Trans id="system.error.copy">Copy</Trans>
    </Button>
  );
}

/**
 * The inline error panel (ux-spec 2.1 X and 6.2): what happened (`what`, with the object named), what it means for the
 * data (`meaning`), what to do (Retry, only when it can help) and the details behind a disclosure: the request id
 * with a Copy button, never the server's own words.
 */
export function ErrorPanel({
  what,
  meaning,
  error,
  onRetry,
  focusOnMount = false,
}: {
  what: ReactNode;
  meaning: ReactNode;
  error: ApiError;
  onRetry?: () => void;
  /** A failed submit moves focus here, so the user is told what failed (WI-F07). */
  focusOnMount?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <div
      ref={ref}
      tabIndex={focusOnMount ? -1 : undefined}
      role="alert"
      className="flex flex-col gap-3 rounded-md border-s-4 border-danger bg-danger-bg px-5 py-4"
    >
      <p className="text-md font-medium">{what}</p>
      <p className="text-sm">{meaning}</p>
      {onRetry && isRetryable(error) ? (
        <div>
          <Button onPress={onRetry}>
            <Trans id="system.error.retry">Retry</Trans>
          </Button>
        </div>
      ) : null}
      {error.requestId ? (
        <details>
          <summary>
            <Trans id="system.error.details">Details</Trans>
          </summary>
          <div className="flex flex-wrap items-center gap-3 pt-3">
            <Trans id="system.error.reference">Reference</Trans>{" "}
            <DirText dir="ltr">{error.requestId}</DirText>
            <CopyReference id={error.requestId} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
