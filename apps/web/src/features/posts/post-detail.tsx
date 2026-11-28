import { Trans } from "@lingui/react/macro";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { readZone } from "../../account/prefs";
import { ApiError, request } from "../../http/client";
import { ForbiddenPage, NotFoundPage } from "../../pages/system-pages";
import { isUnknownWorkspace, useShellData } from "../../shell/shell-data";
import { Button } from "../../ui/button";
import { DirText } from "../../ui/dir-text";
import { ErrorPanel } from "../../ui/error-panel";
import { LocalizedDateTime } from "../../ui/localized";
import { dateOf } from "../channels/channel-facts";
import { useSignIn } from "../channels/channels-hub";
import { Late } from "../media/media-library";
import { TargetActions } from "./post-actions";
import { DuplicateButton, type Place } from "./post-effects";
import {
  type Detail,
  detailSchema,
  evidenceLine,
  factsOfDetail,
  headlineOf,
  permalinkOf,
  pollDelayMs,
  type Target,
  wordOf,
} from "./post-facts";
import { type Names, useNames } from "./post-names";
import {
  EvidenceWords,
  HeadlineMeaning,
  HeadlineWord,
  HeldMediaWords,
  PostLink,
  Summary,
  TargetLabel,
  TargetMeaning,
  usePauseReason,
} from "./post-words";

interface Ready {
  status: "ready";
  detail: Detail;
  reads: number;
  readAt: Date;
  refreshFailed: ApiError | null;
}
type DetailState = { status: "loading" } | { status: "failed"; error: ApiError } | Ready;

// Reads the post, and again every few seconds while something is moving and every minute otherwise. A tab that is hidden
// does not read, and reads at once when it shows again; a read never starts while another is running; a failed read keeps
// what is shown.
function usePostDetail(ws: string, postId: string) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);
  // The sign-in redirect follows the location, so it is kept in a ref: a new function each render must not re-arm a read.
  const signIn = useSignIn();
  const expiredRef = useRef(signIn);
  expiredRef.current = signIn;
  const path = `/api/v1/workspaces/${ws}/posts/${postId}`;

  const read = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const detail = await request(detailSchema, path);
      setState((now) => ({
        status: "ready",
        detail,
        reads: (now.status === "ready" ? now.reads : 0) + 1,
        readAt: new Date(),
        refreshFailed: null,
      }));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.state === "session_expired") return expiredRef.current();
      setState((now) =>
        now.status === "ready"
          ? { ...now, reads: now.reads + 1, refreshFailed: error }
          : { status: "failed", error },
      );
    } finally {
      running.current = false;
    }
  }, [path]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry counter.
  useEffect(() => {
    setState({ status: "loading" });
    void read();
  }, [read, attempt]);

  useReadAgain(state, read);

  return { state, refresh: () => void read(), retry: () => setAttempt((now) => now + 1) };
}

// Arms the next read after each finished one, and reads at once when a hidden tab shows again.
function useReadAgain(state: DetailState, read: () => Promise<void>) {
  const ready = state.status === "ready";
  const targets = state.status === "ready" ? state.detail.targets : null;
  const reads = state.status === "ready" ? state.reads : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each finished read (`reads`) arms the next one.
  useEffect(() => {
    if (!ready || targets === null) return;
    const timer = setTimeout(
      () => {
        if (!document.hidden) void read();
      },
      pollDelayMs(targets, Date.now()),
    );
    const shown = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [ready, reads, read]);
}

function formatValue(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function SettingValue({ value }: { value: unknown }) {
  if (value === true) return <Trans id="posts.settings.yes">Yes</Trans>;
  if (value === false) return <Trans id="posts.settings.no">No</Trans>;
  const shown = formatValue(value);
  return shown === null ? <Trans id="posts.settings.not_set">Not set</Trans> : <DirText>{shown}</DirText>;
}

// Every key the answer has, with its value: the stored settings already hold the channel's defaults.
function Settings({ settings }: { settings: Readonly<Record<string, unknown>> }) {
  const entries = Object.entries(settings);
  return (
    <div data-testid="target-settings" className="text-sm">
      <h4 className="font-medium">
        <Trans id="posts.settings.title">Settings</Trans>
      </h4>
      {entries.length === 0 ? (
        <p>
          <Trans id="posts.settings.none">No settings</Trans>
        </p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-text-muted">
                <DirText>{key.replaceAll("_", " ")}</DirText>
              </dt>
              <dd>
                <SettingValue value={value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Attempts({ attempts }: { attempts: NonNullable<Target["attempts"]> }) {
  return (
    <details data-testid="target-attempts" className="text-sm">
      <summary>
        <Trans id="posts.attempts.title">Attempts</Trans>
      </summary>
      <ul className="flex flex-col gap-1 pt-2">
        {attempts.map((one) => {
          const started = dateOf(one.started_at);
          return (
            <li key={one.attempt_no} data-testid="attempt">
              <Trans id="posts.attempts.number">Attempt {one.attempt_no}</Trans>
              {": "}
              <DirText>
                {[one.step, one.effect, one.http_status, one.error_class]
                  .filter((x) => x !== null)
                  .join(" · ")}
              </DirText>
              {started === null ? null : (
                <>
                  {" · "}
                  <LocalizedDateTime value={started} timeZone={readZone()} />
                </>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function TargetTimes({ target }: { target: Target }) {
  const published = dateOf(target.published_at);
  const due = dateOf(target.due_at);
  if (published !== null) {
    return (
      <Trans id="posts.row.published_at">
        Published <LocalizedDateTime value={published} timeZone={readZone()} />
      </Trans>
    );
  }
  if (due === null || target.operation?.state === "pending") return null;
  return (
    <Trans id="posts.target.due">
      Due <LocalizedDateTime value={due} timeZone={target.due_tz ?? readZone()} />
    </Trans>
  );
}

interface RowProps {
  target: Target;
  variant: Detail["variants"][number] | undefined;
  named: Names;
  place: Place;
}

// A thread is the first text and each reply after it; a first comment is not a part of it.
const threadParts = (variant: RowProps["variant"]) =>
  1 + (variant?.parts.filter((part) => part.kind === "thread_reply").length ?? 0);

function TargetRow({ target, variant, named, place }: RowProps) {
  const row = useRef<HTMLLIElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const refocus = useRef(false);
  // A button that did its work goes away with the next read; focus then moves to the heading of the row.
  useEffect(() => {
    if (!refocus.current || row.current?.contains(document.activeElement)) return;
    refocus.current = false;
    heading.current?.focus();
  });
  const rowPlace = {
    ...place,
    settled: () => {
      refocus.current = true;
    },
  };
  return (
    <li
      ref={row}
      data-testid="post-target"
      data-word={wordOf(factsOfDetail(target))}
      className="flex flex-col items-start gap-2 rounded-md border border-border px-5 py-4"
    >
      <h3 ref={heading} tabIndex={-1} data-testid="target-heading" className="font-medium">
        <DirText>{named.channel}</DirText>
      </h3>
      <TargetSummary target={target} named={named} />
      <p className="whitespace-pre-wrap text-sm">
        <DirText>{variant?.text ?? ""}</DirText>
      </p>
      <Settings settings={target.settings} />
      {target.attempts === undefined ? null : <Attempts attempts={target.attempts} />}
      <TargetActions place={rowPlace} target={target} named={named} parts={threadParts(variant)} />
    </li>
  );
}

function TargetSummary({ target, named }: { target: Target; named: Names }) {
  const facts = factsOfDetail(target);
  const word = wordOf(facts);
  const pause = usePauseReason(target.operation?.reason_code, named.provider);
  const line = word === "published" ? evidenceLine(target.evidence) : null;
  const address = permalinkOf(target.evidence);
  const context = { provider: named.provider, channel: named.channel };
  return (
    <>
      <p data-testid="target-word" className="font-medium">
        <TargetLabel word={word} {...context} pauseReason={pause} />
      </p>
      <p data-testid="target-meaning" className="text-sm">
        <TargetMeaning
          word={word}
          {...context}
          dueAt={dateOf(target.due_at)}
          zone={target.due_tz ?? readZone()}
          deadline={dateOf(named.row?.reconnect_deadline ?? null)}
          partIndex={facts.partIndex}
          effect={facts.effect}
        />
      </p>
      {target.hold_reason === "held_media" ? (
        <p data-testid="target-hold" className="text-sm">
          <HeldMediaWords />
        </p>
      ) : null}
      <p className="text-sm text-text-muted">
        <TargetTimes target={target} />
      </p>
      {line === null ? null : (
        <p data-testid="target-evidence" className="text-sm">
          <EvidenceWords line={line} provider={named.provider} />
        </p>
      )}
      {address === null ? null : <PostLink address={address} provider={named.provider} />}
    </>
  );
}

function RefreshNote({ failed, at }: { failed: ApiError | null; at: Date }) {
  if (failed === null) return null;
  return (
    <p data-testid="post-refresh-note" role="status" className="text-sm">
      <Trans id="posts.refresh_failed">
        We could not refresh this post, so what you see may be out of date.
      </Trans>{" "}
      <Trans id="posts.refresh_as_of">
        Showing it as of <LocalizedDateTime value={at} timeZone={readZone()} />.
      </Trans>
    </p>
  );
}

function Loaded({ ws, ready, refresh }: { ws: string; ready: Ready; refresh: () => void }) {
  const { detail, refreshFailed: failed, readAt } = ready;
  const names = useNames(ws);
  const [said, say] = useState<ReactNode>(null);
  const place = { ws, postId: detail.id, version: detail.current_version_id, refresh, say };
  const headline = headlineOf(detail.status, detail.targets.map(factsOfDetail));
  return (
    <>
      <section data-testid="post-live" role="status" className="flex flex-col gap-1">
        <h2 data-testid="post-headline" className="font-heading text-xl">
          <HeadlineWord headline={headline} />
        </h2>
        <p data-testid="post-summary">
          <Summary headline={headline} />
        </p>
        <p data-testid="post-meaning" className="text-sm">
          <HeadlineMeaning headline={headline} />
        </p>
        {said === null ? null : (
          <p data-testid="post-result" className="font-medium">
            {said}
          </p>
        )}
      </section>
      <RefreshNote failed={failed} at={readAt} />
      <ul className="flex flex-col gap-3">
        {detail.targets.map((target) => (
          <TargetRow
            key={target.variant_id}
            target={target}
            variant={detail.variants.find((one) => one.id === target.variant_id)}
            named={names(target.channel_id)}
            place={place}
          />
        ))}
      </ul>
      {detail.targets.some((target) => target.actions.includes("duplicate")) ? (
        <DuplicateButton place={place} />
      ) : null}
    </>
  );
}

function Skeleton() {
  return (
    <Late label={<Trans id="posts.detail.loading">Loading this post</Trans>}>
      <div data-testid="post-skeleton" className="flex flex-col gap-3">
        <div className="h-16 rounded-md bg-surface-sunken" />
        <div className="h-32 rounded-md bg-surface-sunken" />
      </div>
    </Late>
  );
}

function Failed({ error, retry }: { error: ApiError; retry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <ErrorPanel
        what={<Trans id="posts.detail.failed.what">We could not load this post</Trans>}
        meaning={<Trans id="posts.detail.failed.meaning">Nothing was changed. Try again.</Trans>}
        error={error}
      />
      <Button data-testid="post-retry" onPress={retry}>
        <Trans id="posts.retry">Try again</Trans>
      </Button>
    </div>
  );
}

function PostDetail({ ws, postId }: { ws: string; postId: string }) {
  const { state, retry, refresh } = usePostDetail(ws, postId);
  if (state.status === "failed" && state.error.state === "not_found") return <NotFoundPage />;
  if (state.status === "failed" && state.error.state === "forbidden") return <ForbiddenPage />;
  return (
    <div data-testid="post-state" data-state={state.status} className="flex flex-col gap-5">
      <Link to={`/w/${ws}/posts`} className="min-h-6 pointer-coarse:min-h-11 self-start text-link underline">
        <Trans id="posts.detail.back">All posts</Trans>
      </Link>
      <h1 className="font-heading text-2xl">
        <Trans id="posts.detail.title">Post</Trans>
      </h1>
      {state.status === "loading" ? <Skeleton /> : null}
      {state.status === "failed" ? <Failed error={state.error} retry={retry} /> : null}
      {state.status === "ready" ? <Loaded ws={ws} ready={state} refresh={refresh} /> : null}
    </div>
  );
}

export function PostDetailPage() {
  const { ws = "", postId = "" } = useParams();
  const shell = useShellData();
  if (isUnknownWorkspace(shell, ws)) return <NotFoundPage />;
  return <PostDetail key={`${ws}/${postId}`} ws={ws} postId={postId} />;
}
