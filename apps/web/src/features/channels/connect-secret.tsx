import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { z } from "zod";
import { ApiError, request } from "../../http/client";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { DirText } from "../../ui/dir-text";
import { TextField } from "../../ui/text-field";
import { useSignIn } from "./channels-hub";
import { StartError, type StartFailure, failureOf as startFailureOf } from "./connect-start";

type SecretKind = "bot_token" | "webhook_url";
interface SecretPlatform {
  readonly id: string;
  readonly display_name: string;
  readonly secret_kind: SecretKind;
}

const POLL_MS = 2000;
const OWN_REASONS = [
  "host_not_allowed",
  "secret_refused",
  "provider_unreachable",
  "provider_rate_limited",
  "conflict",
] as const;
type OwnReason = (typeof OWN_REASONS)[number];
type Failure = OwnReason | StartFailure;

const channelAnswer = z.object({ channel_id: z.uuid() });
const challengeAnswer = z.object({ challenge_id: z.uuid(), word: z.string().min(1).max(64) });
const pasteAnswer = z.union([channelAnswer, challengeAnswer]);
const statusAnswer = z.object({
  state: z.enum(["waiting", "matched", "expired", "done", "ended"]),
  chat_title: z.string().nullable(),
  reason: z.enum(["bot_cannot_post"]).nullable(),
});
type StatusState = z.infer<typeof statusAnswer>["state"];
const renewAnswer = z.object({ word: z.string().min(1).max(64) });

const OWN_WORDS: Record<OwnReason, ReactNode> = {
  host_not_allowed: (
    <Trans id="connect.secret.host_not_allowed">
      That address does not belong to this platform. Copy it again from the platform and try again.
    </Trans>
  ),
  secret_refused: (
    <Trans id="connect.secret.refused">
      The platform did not accept that. Check that you copied all of it and try again.
    </Trans>
  ),
  provider_unreachable: (
    <Trans id="connect.secret.unreachable">
      We could not reach the platform. Nothing was changed. Try again later.
    </Trans>
  ),
  provider_rate_limited: (
    <Trans id="connect.secret.rate_limited">
      The platform asked us to wait. Nothing was changed. Try again in a few minutes.
    </Trans>
  ),
  conflict: (
    <Trans id="connect.secret.conflict">
      This cannot be connected here. It may be used by another workspace, or its word may have expired. Start
      again with a new word.
    </Trans>
  ),
};

const isOwn = (reason: unknown): reason is OwnReason => OWN_REASONS.some((one) => one === reason);

function failureOf(error: ApiError): Failure {
  const reason = error.details?.reason;
  if (isOwn(reason)) return reason;
  return error.code === "conflict" ? "conflict" : startFailureOf(error);
}

function SecretError({ failure, testId }: { failure: Failure; testId: string }) {
  if (!isOwn(failure)) return <StartError failure={failure} testId={testId} />;
  return (
    <p data-testid={testId} data-reason={failure} role="alert" className="text-sm">
      {OWN_WORDS[failure]}
    </p>
  );
}

const resultPath = (ws: string, channel: string) =>
  `/connect/result?${new URLSearchParams({ channel, workspace: ws })}`;

// One call at a time; a refusal becomes the words of its reason, and an ended session goes to sign-in.
function useCall() {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const expired = useSignIn();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const refused = (error: unknown) => {
    if (!(error instanceof ApiError)) throw error;
    if (!live.current) return;
    if (error.state === "session_expired") expired();
    else setFailure(failureOf(error));
  };
  const call = async <T,>(run: () => Promise<T>, then: (answer: T) => void) => {
    setBusy(true);
    setFailure(null);
    try {
      const answer = await run();
      if (live.current) then(answer);
    } catch (error) {
      refused(error);
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return { call, busy, failure };
}

const stopOf = (error: ApiError): "session" | "gone" | null => {
  if (error.state === "session_expired") return "session";
  return error.state === "forbidden" || error.state === "not_found" ? "gone" : null;
};

// Reads the challenge every two seconds while it waits. An ended session or a challenge that is not ours will not come
// back by asking again, so either stops the reading; any other failed read is read again at the next beat.
function useStatusPoll(base: string) {
  const [status, setStatus] = useState<z.infer<typeof statusAnswer>["state"]>("waiting");
  const [chat, setChat] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  const [stopped, setStopped] = useState<"session" | "gone" | null>(null);
  const signInNow = useSignIn();
  const signIn = useRef(signInNow);
  signIn.current = signInNow;
  useEffect(() => {
    if (status !== "waiting" || stopped !== null) return;
    let live = true;
    const refused = (error: unknown) => {
      if (!(error instanceof ApiError)) throw error;
      const stop = stopOf(error);
      if (!live || stop === null) return;
      if (stop === "session") signIn.current();
      setStopped(stop);
    };
    const timer = setInterval(() => {
      request(statusAnswer, base).then((answer) => {
        if (!live) return;
        setStatus(answer.state);
        setChat(answer.chat_title);
        setHeld(answer.state === "waiting" && answer.reason === "bot_cannot_post");
      }, refused);
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [status, stopped, base]);
  return { status, setStatus, chat, held, stopped };
}

function StatusWords({ status, chat }: { status: StatusState; chat: string | null }) {
  switch (status) {
    case "waiting":
      return <Trans id="connect.secret.word.waiting">Waiting for the message</Trans>;
    case "matched":
      return (
        <Trans id="connect.secret.word.matched">
          Found{" "}
          <span data-testid="challenge-chat">
            <DirText>{chat ?? ""}</DirText>
          </span>
        </Trans>
      );
    case "expired":
      return <Trans id="connect.secret.word.expired">This word has expired.</Trans>;
    case "ended":
      return (
        <Trans id="connect.secret.word.ended">
          A newer word replaced this one. Close this and use the newest.
        </Trans>
      );
    case "done":
      return <Trans id="connect.secret.word.done">This chat is connected. You can publish to it now.</Trans>;
  }
}

function Waiting({
  ws,
  platform,
  first,
  onDone,
}: {
  ws: string;
  platform: SecretPlatform;
  first: { id: string; word: string };
  onDone: () => void;
}) {
  const [word, setWord] = useState(first.word);
  const { call, busy, failure } = useCall();
  const base = `/api/v1/workspaces/${ws}/connect/${platform.id}/challenge/${first.id}`;
  const { status, setStatus, chat, held, stopped } = useStatusPoll(base);
  const provider = platform.display_name;
  // Not ours any more, whichever read or call found out: nothing left to renew or connect.
  const gone = stopped === "gone" || failure === "not_found" || failure === "forbidden";
  const renew = () =>
    call(
      () => request(renewAnswer, `${base}/renew`, { method: "POST" }),
      (answer) => {
        setWord(answer.word);
        setStatus("waiting");
      },
    );
  const complete = () =>
    call(
      () => request(channelAnswer, `${base}/complete`, { method: "POST", body: { word } }),
      (answer) => window.location.assign(resultPath(ws, answer.channel_id)),
    );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        <Trans id="connect.secret.word.intro">
          Add the bot to the chat or channel you want to publish to, then send this message there:
        </Trans>
      </p>
      <p className="text-md font-medium">
        <DirText dir="ltr">
          /connect <span data-testid="challenge-word">{word}</span>
        </DirText>
      </p>
      <p data-testid="challenge-status" data-state={status} role="status" className="text-sm">
        <StatusWords status={status} chat={chat} />
      </p>
      {!held ? null : (
        <p data-testid="challenge-held" role="status" className="text-sm">
          <Trans id="connect.secret.word.held">
            <DirText>{provider}</DirText> received the word, but the bot cannot post in that chat yet. Give
            the bot the right to post messages, then send the same word again.
          </Trans>
        </p>
      )}
      {!gone ? null : (
        <p data-testid="challenge-gone" role="alert" className="text-sm">
          <Trans id="connect.secret.word.gone">
            This word can no longer be used here. Close this and connect again.
          </Trans>
        </p>
      )}
      {failure === null || gone ? null : <SecretError failure={failure} testId="challenge-error" />}
      <div className="flex flex-wrap gap-3">
        {status === "done" ? (
          <Button data-testid="challenge-next" onPress={onDone}>
            <Trans id="connect.secret.word.next">Show my channels</Trans>
          </Button>
        ) : null}
        {status === "matched" && !gone ? (
          <Button data-testid="challenge-complete" busy={busy} onPress={complete}>
            <Trans id="connect.secret.word.connect">Connect this chat</Trans>
          </Button>
        ) : null}
        {status === "expired" && !gone ? (
          <Button data-testid="challenge-renew" busy={busy} onPress={renew}>
            <Trans id="connect.secret.word.renew">Generate a new word</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// The pasted value is Latin and never shown: it is a secret, so it goes in a password field read left to right.
export function SecretStep(props: {
  ws: string;
  platform: SecretPlatform;
  onBack: () => void;
  /** Called when a held challenge ended `done` and the person asks to see the channels. */
  onDone: () => void;
  /** The channel a reconnect is for: the secret is then checked as one of that channel's account. */
  channelId?: string;
}) {
  const { t } = useLingui();
  const { ws, platform } = props;
  const provider = platform.display_name;
  const [typed, setTyped] = useState("");
  const [held, setHeld] = useState<{ id: string; word: string } | null>(null);
  const { call, busy, failure } = useCall();
  const hook = platform.secret_kind === "webhook_url";
  const label = hook
    ? t({ id: "connect.secret.hook.label", message: "Webhook address" })
    : t({ id: "connect.secret.bot.label", message: "Bot token" });
  const submit = () => {
    const secret = typed.trim();
    if (secret === "") return;
    void call(
      () =>
        request(pasteAnswer, `/api/v1/workspaces/${ws}/connect/${platform.id}/secret`, {
          method: "POST",
          body: { secret, ...(props.channelId === undefined ? {} : { channel_id: props.channelId }) },
        }),
      (answer) => {
        setTyped("");
        if ("channel_id" in answer) window.location.assign(resultPath(ws, answer.channel_id));
        else setHeld({ id: answer.challenge_id, word: answer.word });
      },
    );
  };
  return (
    <div className="flex flex-col gap-3">
      {held === null ? (
        <Form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p className="text-sm">
            {hook ? (
              <Trans id="connect.secret.hook.intro">
                Paste the webhook address of the channel in <DirText>{provider}</DirText> you want to publish
                to.
              </Trans>
            ) : (
              <Trans id="connect.secret.bot.intro">
                Paste the token of the bot you made in <DirText>{provider}</DirText>. Shoutory keeps it
                sealed.
              </Trans>
            )}
          </p>
          <TextField
            label={label}
            testId="secret-field"
            autoFocus
            ltr
            type="password"
            autoComplete="off"
            value={typed}
            onChange={setTyped}
          />
          {failure === null ? null : <SecretError failure={failure} testId="secret-error" />}
          <div className="flex flex-wrap gap-3">
            <Button data-testid="secret-back" onPress={props.onBack}>
              <Trans id="connect.wizard.host.back">Back</Trans>
            </Button>
            <Button data-testid="secret-continue" type="submit" busy={busy}>
              <Trans id="connect.secret.continue">Check and continue</Trans>
            </Button>
          </div>
        </Form>
      ) : (
        <>
          <Waiting ws={ws} platform={platform} first={held} onDone={props.onDone} />
          <div>
            <Button data-testid="secret-back" onPress={props.onBack}>
              <Trans id="connect.wizard.host.back">Back</Trans>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// The Reconnect of a channel made from a secret opens the paste step for that channel, never an authorization.
export function ReconnectSecret(props: {
  ws: string;
  platform: SecretPlatform;
  channelId: string;
  nameId: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-testid="card-reconnect" aria-describedby={props.nameId} onPress={() => setOpen(true)}>
        <Trans id="channels.hub.reconnect">Reconnect</Trans>
      </Button>
      <Dialog
        title={<Trans id="connect.secret.reconnect.title">Reconnect this channel</Trans>}
        isOpen={open}
        onOpenChange={setOpen}
      >
        <SecretStep
          ws={props.ws}
          platform={props.platform}
          channelId={props.channelId}
          onBack={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            props.onDone();
          }}
        />
      </Dialog>
    </>
  );
}
