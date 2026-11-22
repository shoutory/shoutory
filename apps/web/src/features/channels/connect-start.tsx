import { Trans } from "@lingui/react/macro";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ApiError, request } from "../../http/client";
import { Button } from "../../ui/button";
import { useSignIn } from "./channels-hub";

// Starting the OAuth flow: one POST that answers where to send the browser. The browser goes there only when the
// server's answer is an https address, never from a query, a prop or storage; anything else is the error line.

export type StartFailure = "forbidden" | "not_found" | "rate_limited" | "unavailable" | "server";
const answerSchema = z.object({ authorize_url: z.string() });

const START_WORDS: Record<StartFailure, ReactNode> = {
  forbidden: (
    <Trans id="connect.start.forbidden">
      You cannot connect channels in this workspace. Ask an owner or admin of this workspace.
    </Trans>
  ),
  not_found: (
    <Trans id="connect.start.not_found">
      This platform or channel is no longer available here. Close this and open the channels again.
    </Trans>
  ),
  rate_limited: (
    <Trans id="connect.start.rate_limited">
      Too many connection attempts. Wait a few minutes, then start again.
    </Trans>
  ),
  unavailable: (
    <Trans id="connect.start.unavailable">
      We could not start the connection. Nothing was changed. Try again.
    </Trans>
  ),
  server: (
    <Trans id="connect.start.server">
      Something went wrong on our side. Nothing was changed. Try again later.
    </Trans>
  ),
};

/** The line of a failed start; `testId` names it for the part of the page that shows it. */
export function StartError({ failure, testId }: { failure: StartFailure; testId: string }) {
  return (
    <p data-testid={testId} data-reason={failure} role="alert" className="text-sm">
      {START_WORDS[failure]}
    </p>
  );
}

// The address as the browser will take it, or null when it is not an https address.
function httpsAddress(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException) return null;
    throw error;
  }
}

function failureOf(error: ApiError): StartFailure {
  if (error.state === "forbidden") return "forbidden";
  if (error.state === "not_found") return "not_found";
  if (error.status === 429) return "rate_limited";
  return error.state === "maintenance" ? "unavailable" : "server";
}

/** The Reconnect button of a card: it starts the connection of that channel through its own provider. */
export function Reconnect(props: { ws: string; providerId: string; channelId: string; nameId: string }) {
  const { start, busy, failure } = useStart(props.ws);
  return (
    <>
      <Button
        data-testid="card-reconnect"
        aria-describedby={props.nameId}
        busy={busy}
        onPress={() => start(props.providerId, props.channelId)}
      >
        <Trans id="channels.hub.reconnect">Reconnect</Trans>
      </Button>
      {failure === null ? null : <StartError failure={failure} testId="card-reconnect-error" />}
    </>
  );
}

/**
 * The start of a connection in workspace `ws`. A second press while one is pending is ignored, and the page showing
 * again (the back button restores it) lets the person press again. An answer that arrives after the part of the page
 * that started it is gone (a closed dialog, another workspace) moves nothing.
 */
export function useStart(ws: string) {
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const pressed = useRef(false);
  const live = useRef(true);
  const expired = useSignIn();

  // One definition for the handlers and the page-show listener; it only touches a ref and a state setter, so it is stable
  // and the listener is subscribed once.
  const release = useCallback(() => {
    pressed.current = false;
    setBusy(false);
  }, []);

  useEffect(() => {
    live.current = true;
    window.addEventListener("pageshow", release);
    return () => {
      live.current = false;
      window.removeEventListener("pageshow", release);
    };
  }, [release]);

  const follow = (address: string) => {
    const safe = httpsAddress(address);
    if (safe === null) {
      release();
      setFailure("server");
    } else {
      window.location.assign(safe);
    }
  };
  const refused = (error: unknown) => {
    if (!(error instanceof ApiError)) {
      release();
      throw error;
    }
    if (!live.current) return;
    release();
    if (error.state === "session_expired") expired();
    else setFailure(failureOf(error));
  };
  /** Starts the connection; false when one is already pending and nothing was sent. */
  const start = (providerId: string, channelId?: string): boolean => {
    if (pressed.current) return false;
    pressed.current = true;
    setBusy(true);
    setFailure(null);
    const body = channelId === undefined ? {} : { channel_id: channelId };
    request(answerSchema, `/api/v1/workspaces/${ws}/connect/${providerId}/start`, {
      method: "POST",
      body,
    }).then((answer) => live.current && follow(answer.authorize_url), refused);
    return true;
  };
  return { start, busy, failure };
}
