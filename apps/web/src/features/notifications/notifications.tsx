import { plural, select } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { z } from "zod";
import { readZone } from "../../account/prefs";
import { ApiError, request } from "../../http/client";
import { formatNumber } from "../../i18n/i18n";
import { NotFoundPage } from "../../pages/system-pages";
import { isUnknownWorkspace, useShellData } from "../../shell/shell-data";
import { Button } from "../../ui/button";
import { EmptyState } from "../../ui/empty-state";
import { ErrorPanel } from "../../ui/error-panel";
import { LocalizedDateTime, useFormatPrefs } from "../../ui/localized";
import { useSignIn } from "../channels/channels-hub";

const noticeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  subject_id: z.string(),
  level: z.string(),
  vars: z
    .object({
      name: z.string().optional(),
      days: z.number().optional(),
    })
    .catch({}),
  created_at: z.string(),
});
type Notice = z.infer<typeof noticeSchema>;
const pageSchema = z.object({
  data: z.array(noticeSchema),
  meta: z.object({ next_cursor: z.string().nullable() }),
});
type Page = z.infer<typeof pageSchema>;

type State =
  | { status: "loading" }
  | { status: "failed"; error: ApiError }
  | { status: "ready"; rows: Notice[]; next: string | null; more: "idle" | "busy" | "failed" };

const readPage = (base: string, cursor?: string) =>
  request(pageSchema, cursor === undefined ? base : `${base}?cursor=${encodeURIComponent(cursor)}`, {
    envelope: false,
  });

const firstPage = (page: Page): State => ({
  status: "ready",
  rows: page.data,
  next: page.meta.next_cursor,
  more: "idle",
});

function useNotices(ws: string) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const moreBusy = useRef(false);
  const expired = useSignIn();
  const base = `/api/v1/workspaces/${ws}/notifications`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry counter; `expired` follows the location.
  useEffect(() => {
    let live = true;
    readPage(base).then(
      (page) => live && setState(firstPage(page)),
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
        if (!live) return;
        if (error.state === "session_expired") expired();
        else setState({ status: "failed", error });
      },
    );
    return () => {
      live = false;
    };
  }, [base, attempt]);

  const loadMore = () => {
    if (state.status !== "ready" || state.next === null || moreBusy.current) return;
    moreBusy.current = true;
    setState({ ...state, more: "busy" });
    readPage(base, state.next).then(
      (page) => {
        moreBusy.current = false;
        setState((now) => {
          if (now.status !== "ready") return now;
          const known = new Set(now.rows.map((one) => one.id));
          const fresh = page.data.filter((one) => !known.has(one.id));
          return { ...now, rows: [...now.rows, ...fresh], next: page.meta.next_cursor, more: "idle" };
        });
      },
      (error: unknown) => {
        moreBusy.current = false;
        setState((now) => (now.status === "ready" ? { ...now, more: "failed" } : now));
        if (!(error instanceof ApiError)) throw error;
        if (error.state === "session_expired") expired();
      },
    );
  };
  const retry = () => {
    setState({ status: "loading" });
    setAttempt((now) => now + 1);
  };
  return { state, loadMore, retry };
}

// A user-chosen name inside a sentence of the other direction would reorder the words around it; isolating it keeps
// the sentence readable, and a direction mark inside the name could end the isolation early, so the name keeps none.
const isolate = (value: string) =>
  `${String.fromCodePoint(0x2068)}${value.replaceAll(/\p{Bidi_Control}/gu, "")}${String.fromCodePoint(0x2069)}`;

// The days come from the notice's own variable, else from its level (`g1:7d`: the credential's generation, then the days).
const daysOf = (notice: Notice): number =>
  notice.vars.days ?? (Number.parseInt(/:(\d+)d$/.exec(notice.level)?.[1] ?? "", 10) || 1);

// 0 is the first notice of an unclear post; each later step is a reminder.
const isReminder = (level: string): boolean => {
  const step = /^escalation_(\d+)$/.exec(level)?.[1];
  return step !== undefined && Number(step) > 0;
};

function useSentence() {
  const { t } = useLingui();
  const prefs = useFormatPrefs();
  const fallback = t({ id: "notices.a_channel", message: "a channel" });
  return (notice: Notice): string => {
    const reminded = isReminder(notice.level) ? "yes" : "no";
    const who = notice.vars.name === undefined ? fallback : isolate(notice.vars.name);
    const days = daysOf(notice);
    const shown = formatNumber(days, prefs);
    switch (notice.kind) {
      case "token_expiry":
        return t({
          id: "notices.token_expiry",
          message: plural(days, {
            one: `Access to ${who} ends in 1 day. Reconnect it before then.`,
            other: `Access to ${who} ends in ${shown} days. Reconnect it before then.`,
          }),
        });
      case "reconnect_deadline":
        return t({
          id: "notices.reconnect_deadline",
          message: plural(days, {
            one: `${who} is not connected. Its waiting posts are kept for 1 more day.`,
            other: `${who} is not connected. Its waiting posts are kept for ${shown} more days.`,
          }),
        });
      case "needs_human":
        return t({
          id: "notices.needs_human",
          message: select(reminded, {
            yes: `Reminder: A post to ${who} needs your decision.`,
            other: `A post to ${who} needs your decision.`,
          }),
        });
      case "unverified":
        return t({
          id: "notices.unverified",
          message: select(reminded, {
            yes: `Reminder: A post to ${who} is not confirmed. Check the channel, then tell us what you found.`,
            other: `A post to ${who} is not confirmed. Check the channel, then tell us what you found.`,
          }),
        });
      case "held_media":
        return t({ id: "notices.held_media", message: `A post to ${who} is waiting for its media.` });
      case "drafts_day_30":
        return t({
          id: "notices.drafts_day_30",
          message: `Posts held for ${who} are back in your drafts. Nothing was deleted.`,
        });
      default:
        return t({ id: "notices.unknown", message: "Something needs your attention." });
    }
  };
}

// The subject of a token or reconnect notice is a credential and of a post notice an operation or a variant, so only a
// day-30 notice, whose subject is the post, links to one post.
function nextStep(notice: Notice, ws: string): { to: string; label: "channels" | "posts" | "post" } | null {
  switch (notice.kind) {
    case "token_expiry":
    case "reconnect_deadline":
      return { to: `/w/${ws}/channels`, label: "channels" };
    case "needs_human":
    case "unverified":
    case "held_media":
      return { to: `/w/${ws}/posts`, label: "posts" };
    case "drafts_day_30":
      return { to: `/w/${ws}/posts/${notice.subject_id}`, label: "post" };
    default:
      return null;
  }
}

const STEP_WORDS = {
  channels: <Trans id="notices.open_channels">Open channels</Trans>,
  posts: <Trans id="notices.open_posts">Open posts</Trans>,
  post: <Trans id="notices.open_post">Open the post</Trans>,
};

function Row({ notice, ws, sentence }: { notice: Notice; ws: string; sentence: (notice: Notice) => string }) {
  const step = nextStep(notice, ws);
  const when = new Date(notice.created_at);
  return (
    <li
      data-testid="notice"
      data-kind={notice.kind}
      className="flex flex-col items-start gap-1 rounded-md border border-border px-5 py-4"
    >
      <p>{sentence(notice)}</p>
      {Number.isNaN(when.getTime()) ? null : (
        <span className="text-sm text-text-muted">
          <LocalizedDateTime value={when} timeZone={readZone()} />
        </span>
      )}
      {step === null ? null : (
        <Link to={step.to} className="min-h-6 pointer-coarse:min-h-11 text-link underline">
          {STEP_WORDS[step.label]}
        </Link>
      )}
    </li>
  );
}

function Failed({ error, retry }: { error: ApiError; retry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <ErrorPanel
        what={<Trans id="notices.failed.what">We could not load your notices</Trans>}
        meaning={<Trans id="notices.failed.meaning">Nothing was changed. Try again.</Trans>}
        error={error}
      />
      <Button data-testid="notices-retry" onPress={retry}>
        <Trans id="channels.hub.retry">Try again</Trans>
      </Button>
    </div>
  );
}

function Loaded({
  state,
  ws,
  loadMore,
}: {
  state: Extract<State, { status: "ready" }>;
  ws: string;
  loadMore: () => void;
}) {
  const sentence = useSentence();
  if (state.rows.length === 0) {
    return (
      <EmptyState kind="cleared" title={<Trans id="notices.empty.title">You are all caught up</Trans>}>
        <Trans id="notices.empty.meaning">New notices about your channels and posts show here.</Trans>
      </EmptyState>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-3">
        {state.rows.map((notice) => (
          <Row key={notice.id} notice={notice} ws={ws} sentence={sentence} />
        ))}
      </ul>
      {state.next === null ? null : (
        <div className="flex flex-col items-start gap-3">
          {state.more === "failed" ? (
            <p data-testid="notices-more-error" role="alert">
              <Trans id="notices.more_failed">
                We could not load older notices. The ones above are still current. Try again.
              </Trans>
            </p>
          ) : null}
          <Button data-testid="notices-more" busy={state.more === "busy"} onPress={loadMore}>
            <Trans id="notices.more">Show more</Trans>
          </Button>
        </div>
      )}
    </>
  );
}

function Notices({ ws }: { ws: string }) {
  const { state, loadMore, retry } = useNotices(ws);
  const name = state.status === "ready" && state.rows.length === 0 ? "empty" : state.status;
  return (
    <div data-testid="notices-state" data-state={name} className="flex flex-col gap-5">
      <h1 className="font-heading text-2xl">
        <Trans id="notices.title">Notifications</Trans>
      </h1>
      {state.status === "loading" ? (
        <div role="status" aria-busy="true">
          <Trans id="notices.loading">Loading your notices</Trans>
        </div>
      ) : null}
      {state.status === "failed" ? <Failed error={state.error} retry={retry} /> : null}
      {state.status === "ready" ? <Loaded state={state} ws={ws} loadMore={loadMore} /> : null}
    </div>
  );
}

export function NotificationsPage() {
  const { ws = "" } = useParams();
  const shell = useShellData();
  if (isUnknownWorkspace(shell, ws)) return <NotFoundPage />;
  return <Notices key={ws} ws={ws} />;
}
