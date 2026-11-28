import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { z } from "zod";
import { readZone } from "../../account/prefs";
import { useAction } from "../../auth/auth-frame";
import { useStepUp } from "../../auth/step-up";
import { ApiError, keyedPost, request } from "../../http/client";
import { formatNumber } from "../../i18n/i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { DirText } from "../../ui/dir-text";
import { ErrorPanel } from "../../ui/error-panel";
import { LocalizedDateTime, useFormatPrefs } from "../../ui/localized";
import { dateOf } from "./channel-facts";
import { useSignIn } from "./channels-hub";

const impactSchema = z.object({
  scheduled: z.array(z.object({ variantId: z.string(), postId: z.string(), dueAt: z.string().nullable() })),
  blocking: z.array(z.object({ id: z.string() })),
  canDisconnect: z.boolean(),
});
type Impact = z.infer<typeof impactSchema>;

const answerSchema = z.object({
  connection_state: z.string(),
  reconnect_deadline: z.string().nullable(),
  revoke: z.enum(["done", "failed", "unsupported"]),
});
type Answer = z.infer<typeof answerSchema>;
type Revoke = Answer["revoke"];

type Step =
  | { name: "loading" }
  | { name: "unreadable"; error: ApiError }
  | { name: "ready"; impact: Impact }
  | { name: "waiting"; count: number }
  | { name: "refused"; why: "forbidden" | "step_up" | "unconfirmed" }
  | { name: "done"; answer: Answer };

const SHOWN_AT_FIRST = 5;

function useImpact(base: string, open: boolean, set: (step: Step) => void) {
  const [attempt, setAttempt] = useState(0);
  const expired = useSignIn();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the read-again counter; `expired` follows the location.
  useEffect(() => {
    if (!open) return;
    let live = true;
    set({ name: "loading" });
    request(impactSchema, `${base}/disconnect-impact`).then(
      (impact) => {
        if (!live) return;
        const { blocking } = impact;
        set(impact.canDisconnect ? { name: "ready", impact } : { name: "waiting", count: blocking.length });
      },
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
        if (!live) return;
        if (error.state === "session_expired") expired();
        else set({ name: "unreadable", error });
      },
    );
    return () => {
      live = false;
    };
  }, [base, open, attempt]);
  return () => setAttempt((now) => now + 1);
}

function useDisconnect(base: string, set: (step: Step) => void) {
  const stepUp = useStepUp();
  const expired = useSignIn();
  // One key per disconnect: the repeat after the password check and a retry after a lost answer share it.
  const post = useRef(keyedPost());
  return useAction(
    async () => {
      const answer = await stepUp(() => post.current(answerSchema, `${base}/disconnect`, {}));
      post.current = keyedPost();
      set(
        answer.connection_state === "disconnected"
          ? { name: "done", answer }
          : { name: "refused", why: "unconfirmed" },
      );
    },
    (error) => {
      // A refusal is an answer: the next try is a new request. Only a lost answer keeps the key.
      if (error.status >= 400 && error.status < 500) post.current = keyedPost();
      if (error.state === "session_expired") return expired();
      if (error.details?.reason === "channel_busy") {
        return set({ name: "waiting", count: error.lists?.blocking?.length ?? 0 });
      }
      if (error.code === "step_up_required") return set({ name: "refused", why: "step_up" });
      set({ name: "refused", why: error.state === "forbidden" ? "forbidden" : "unconfirmed" });
    },
  );
}

function Scheduled({ ws, impact }: { ws: string; impact: Impact }) {
  const { t } = useLingui();
  const prefs = useFormatPrefs();
  const [all, setAll] = useState(false);
  const count = impact.scheduled.length;
  const shown = formatNumber(count, prefs);
  const rows = all ? impact.scheduled : impact.scheduled.slice(0, SHOWN_AT_FIRST);
  return (
    <div className="flex flex-col gap-2">
      <p data-testid="disconnect-count">
        {t({
          id: "channels.disconnect.scheduled",
          message: plural(count, {
            0: "No posts are scheduled for this channel.",
            one: "1 post is scheduled for this channel.",
            other: `${shown} posts are scheduled for this channel.`,
          }),
        })}
      </p>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const due = dateOf(row.dueAt);
          return (
            <li key={row.variantId}>
              <Link
                to={`/w/${ws}/posts/${row.postId}`}
                className="inline-flex min-h-6 pointer-coarse:min-h-11 items-center text-link underline"
              >
                {due === null ? (
                  <Trans id="channels.disconnect.post_no_time">Post with no time set</Trans>
                ) : (
                  <Trans id="channels.disconnect.post_due">
                    Post due <LocalizedDateTime value={due} timeZone={readZone()} />
                  </Trans>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      {count > SHOWN_AT_FIRST && !all ? (
        <div>
          <Button data-testid="disconnect-show-all" onPress={() => setAll(true)}>
            <Trans id="channels.disconnect.show_all">Show all posts</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Waiting({ ws, count }: { ws: string; count: number }) {
  const { t } = useLingui();
  const shown = formatNumber(count, useFormatPrefs());
  return (
    <div data-testid="disconnect-waiting" className="flex flex-col items-start gap-2">
      <p role="alert">
        {t({
          id: "channels.disconnect.waiting",
          message: plural(count, {
            one: "Disconnect waits while 1 post is being sent",
            other: `Disconnect waits while ${shown} posts are being sent`,
          }),
        })}
      </p>
      <p>
        <Trans id="channels.disconnect.waiting_hint">Wait for these to finish or resolve them.</Trans>
      </p>
      <Link
        to={`/w/${ws}/posts`}
        className="inline-flex min-h-6 pointer-coarse:min-h-11 items-center text-link underline"
      >
        <Trans id="channels.disconnect.open_posts">Open posts</Trans>
      </Link>
    </div>
  );
}

function Promises() {
  return (
    <>
      <p>
        <Trans id="channels.disconnect.window">
          You can reconnect for 30 days. Posts waiting for this channel are held, not deleted; after 30 days
          they become drafts. Your data is kept.
        </Trans>
      </p>
      <p>
        <Trans id="channels.disconnect.revoke_preview">
          We will also ask the platform to end this access where it supports that.
        </Trans>
      </p>
    </>
  );
}

const REFUSED_WORDS: Record<"forbidden" | "step_up" | "unconfirmed", ReactNode> = {
  forbidden: (
    <Trans id="channels.disconnect.forbidden">
      You cannot disconnect channels in this workspace. Ask an owner or admin of this workspace.
    </Trans>
  ),
  step_up: (
    <Trans id="channels.disconnect.step_up">
      Disconnecting needs your password again. Nothing was changed.
    </Trans>
  ),
  unconfirmed: (
    <Trans id="channels.disconnect.unconfirmed">
      We could not confirm that the channel was disconnected. Reload the page to see its state before you try
      again.
    </Trans>
  ),
};

function RevokeLine({ revoke, provider }: { revoke: Revoke; provider: string }) {
  return (
    <p data-testid="disconnect-revoke" data-revoke={revoke}>
      {revoke === "done" ? (
        <Trans id="channels.disconnect.revoke_done">
          The platform confirmed that Shoutory's access was removed.
        </Trans>
      ) : null}
      {revoke === "failed" ? (
        <Trans id="channels.disconnect.revoke_failed">
          The platform did not confirm that Shoutory's access was removed. Shoutory's own copy is deleted.
          Remove Shoutory's access in your account settings on <DirText>{provider}</DirText>.
        </Trans>
      ) : null}
      {revoke === "unsupported" ? (
        <Trans id="channels.disconnect.revoke_unsupported">
          <DirText>{provider}</DirText> gives Shoutory no way to remove access. Shoutory's own copy is
          deleted. Remove Shoutory's access in your account settings on <DirText>{provider}</DirText>.
        </Trans>
      ) : null}
    </p>
  );
}

function Done({ answer, provider, onClose }: { answer: Answer; provider: string; onClose: () => void }) {
  const deadline = dateOf(answer.reconnect_deadline);
  return (
    <>
      <p data-testid="disconnect-done" role="status" className="font-medium">
        <Trans id="channels.disconnect.done">Disconnected</Trans>
      </p>
      <RevokeLine revoke={answer.revoke} provider={provider} />
      {deadline === null ? null : (
        <p>
          <Trans id="channels.hub.deadline">
            Reconnect by <LocalizedDateTime value={deadline} timeZone={readZone()} />
          </Trans>
        </p>
      )}
      <div>
        <Button data-testid="disconnect-close" onPress={onClose}>
          <Trans id="channels.disconnect.close">Close</Trans>
        </Button>
      </div>
    </>
  );
}

interface Props {
  ws: string;
  base: string;
  provider: string;
  /** Called after a finished disconnect is closed, so the page reads the channel again. */
  onDone: () => void;
}

function Content(props: Props & { step: Step; busy: boolean; online: boolean } & Handlers) {
  const { step, ws } = props;
  const { t } = useLingui();
  if (step.name === "loading") {
    return (
      <p role="status" aria-busy="true">
        <Trans id="channels.disconnect.loading">Checking what this channel is used for</Trans>
      </p>
    );
  }
  if (step.name === "unreadable") {
    return (
      <div className="flex flex-col items-start gap-3">
        <ErrorPanel
          what={
            <Trans id="channels.disconnect.unreadable.what">
              We could not check what this channel is used for
            </Trans>
          }
          meaning={<Trans id="channels.disconnect.unreadable.meaning">Nothing was changed. Try again.</Trans>}
          error={step.error}
        />
        <Button data-testid="disconnect-retry" onPress={props.onRetry}>
          <Trans id="channels.hub.retry">Try again</Trans>
        </Button>
      </div>
    );
  }
  if (step.name === "done")
    return <Done answer={step.answer} provider={props.provider} onClose={props.onClose} />;
  if (step.name === "waiting") return <Waiting ws={ws} count={step.count} />;
  const offline = t({ id: "auth.offline", message: "You are offline. This needs the server." });
  return (
    <>
      {step.name === "ready" ? <Scheduled ws={ws} impact={step.impact} /> : null}
      <Promises />
      {step.name === "refused" ? (
        <p data-testid="disconnect-refused" data-why={step.why} role="alert">
          {REFUSED_WORDS[step.why]}
        </p>
      ) : null}
      <Button
        data-testid="disconnect-confirm"
        busy={props.busy}
        aria-disabled={props.busy || !props.online}
        {...(props.online ? {} : { reason: offline })}
        onPress={props.onConfirm}
      >
        <Trans id="channels.disconnect.confirm">Disconnect</Trans>
      </Button>
    </>
  );
}

interface Handlers {
  onRetry: () => void;
  onClose: () => void;
  onConfirm: () => void;
}

export function DisconnectButton(props: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ name: "loading" });
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const retry = useImpact(props.base, open, setStep);
  const disconnect = useDisconnect(props.base, setStep);
  // Closing returns focus to the button, also where the press did not focus it first.
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const close = () => {
    const finished = step.name === "done";
    setOpen(false);
    if (finished) props.onDone();
  };
  return (
    <>
      <Button ref={trigger} data-testid="detail-disconnect" onPress={() => setOpen(true)}>
        <Trans id="channels.disconnect.open">Disconnect</Trans>
      </Button>
      <Dialog
        role="alertdialog"
        isOpen={open}
        locked={disconnect.pending}
        onOpenChange={(next) => !next && !disconnect.pending && close()}
        title={
          step.name === "done" ? (
            <Trans id="channels.disconnect.done_title">Channel disconnected</Trans>
          ) : (
            <Trans id="channels.disconnect.title">Disconnect this channel?</Trans>
          )
        }
      >
        <Content
          {...props}
          step={step}
          busy={disconnect.pending}
          online={disconnect.online}
          onRetry={retry}
          onClose={close}
          onConfirm={() => void disconnect.run()}
        />
        {step.name === "done" ? null : (
          <div>
            <Button aria-disabled={disconnect.pending} onPress={close}>
              <Trans id="channels.disconnect.cancel">Cancel</Trans>
            </Button>
          </div>
        )}
      </Dialog>
    </>
  );
}
