import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { z } from "zod";
import { readZone } from "../../account/prefs";
import { type ApiError, request } from "../../http/client";
import { formatNumber } from "../../i18n/i18n";
import { ForbiddenPage, NotFoundPage } from "../../pages/system-pages";
import { isUnknownWorkspace, useShellData } from "../../shell/shell-data";
import { Button } from "../../ui/button";
import { DirText } from "../../ui/dir-text";
import { ErrorPanel } from "../../ui/error-panel";
import { LocalizedDateTime, useFormatPrefs } from "../../ui/localized";
import { useSignIn } from "../channels/channels-hub";
import {
  asApiError,
  copyStateWords,
  copyWords,
  type Detail,
  detailSchema,
  type Fit,
  fitSchema,
  fitWords,
  hasThumb,
  kindOf,
  REASON_WORDS,
  reasonOf,
  STATE_WORDS,
  stateOf,
  UNKNOWN_REASON,
  UNKNOWN_STATE,
} from "./media";
import { type EditHandlers, MediaActions } from "./media-edit";
import { KindIcon, Late } from "./media-library";

type DetailState =
  | { status: "loading" }
  | { status: "failed"; error: ApiError; busy: boolean }
  | { status: "ready"; medium: Detail; read: number }
  | { status: "gone" };

// A read again (Try again, or the file changed state) keeps the page on screen until the answer arrives; a file
// deleted meanwhile stays gone.
function useDetail(base: string) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const expired = useSignIn();
  const unlessGone = (next: DetailState) => setState((now) => (now.status === "gone" ? now : next));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the read-again counter.
  useEffect(() => {
    let live = true;
    request(detailSchema, base).then(
      (medium) => live && unlessGone({ status: "ready", medium, read: attempt }),
      (error: unknown) => {
        const answer = asApiError(error);
        if (!live) return;
        if (answer.state === "session_expired") expired();
        else unlessGone({ status: "failed", error: answer, busy: false });
      },
    );
    return () => {
      live = false;
    };
  }, [base, attempt]);
  const readAgain = () => {
    setState((now) => (now.status === "failed" ? { ...now, busy: true } : now));
    setAttempt((now) => now + 1);
  };
  // A fit refusal reads the file again once; a file that stays ready with no usable copy would loop otherwise.
  const refits = useRef(0);
  const notReady = () => {
    refits.current += 1;
    if (refits.current === 1) readAgain();
    return refits.current === 1;
  };
  const show = (medium: Detail) => setState((now) => (now.status === "ready" ? { ...now, medium } : now));
  return { state, readAgain, notReady, show, gone: () => setState({ status: "gone" }) };
}

const channelsSchema = z.object({
  data: z.array(z.object({ id: z.uuid(), display_name: z.string().nullable() })),
});

// Only a caller who may see the channels gets their names; anyone else, or a failed read, gets ordinals.
function useChannelNames(ws: string) {
  const [names, setNames] = useState(new Map<string, string>());
  useEffect(() => {
    let live = true;
    request(channelsSchema, `/api/v1/workspaces/${ws}/channels?limit=100`, { envelope: false }).then(
      (page) => {
        const named = page.data.flatMap((one) =>
          one.display_name ? [[one.id, one.display_name] as const] : [],
        );
        if (live) setNames(new Map(named));
      },
      (error: unknown) => asApiError(error),
    );
    return () => {
      live = false;
    };
  }, [ws]);
  return names;
}

interface FitReady {
  status: "ready";
  rows: Fit[];
  next: string | null;
  more: "idle" | "busy" | "failed";
}
type FitState = { status: "loading" } | { status: "failed"; error: ApiError } | { status: "gone" } | FitReady;

interface FitHandlers {
  onNotReady: () => boolean;
  onExpired: () => void;
}

// A 409 reads the file again, which reads the fit again while the file is still ready.
function settleFitError(answer: ApiError, handlers: FitHandlers): FitState {
  if (answer.status === 404) return { status: "gone" };
  if (answer.status === 409 && handlers.onNotReady()) return { status: "loading" };
  if (answer.state === "session_expired") handlers.onExpired();
  return { status: "failed", error: answer };
}

function useFit(base: string, onNotReady: () => boolean) {
  const [state, setState] = useState<FitState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const expired = useSignIn();
  const handlers = { onNotReady, onExpired: expired };
  const read = (cursor: string | null) =>
    request(fitSchema, `${base}/fit${cursor === null ? "" : `?cursor=${cursor}`}`, { envelope: false });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Check again counter.
  useEffect(() => {
    const asked = ++generation.current;
    setState({ status: "loading" });
    read(null).then(
      (page) =>
        asked === generation.current &&
        setState({ status: "ready", rows: page.data, next: page.meta.next_cursor, more: "idle" }),
      (error: unknown) => {
        const answer = asApiError(error);
        if (asked === generation.current) setState(settleFitError(answer, handlers));
      },
    );
  }, [base, attempt]);

  const loadMore = () => {
    if (state.status !== "ready" || state.next === null || state.more === "busy") return;
    setState({ ...state, more: "busy" });
    // A page asked for before Check again is dropped once the fit is read again.
    const asked = generation.current;
    const settled = (change: (now: FitReady) => FitState) =>
      asked === generation.current && setState((now) => (now.status === "ready" ? change(now) : now));
    read(state.next).then(
      (page) =>
        settled((now) => ({
          ...now,
          rows: [...now.rows, ...page.data],
          next: page.meta.next_cursor,
          more: "idle",
        })),
      (error: unknown) => {
        const answer = asApiError(error);
        if (asked !== generation.current) return;
        if (answer.status === 404 || answer.status === 409 || answer.state === "session_expired") {
          setState(settleFitError(answer, handlers));
          return;
        }
        settled((now) => ({ ...now, more: "failed" }));
      },
    );
  };
  return { state, loadMore, checkAgain: () => setAttempt((now) => now + 1) };
}

function Preview({ medium, ws }: { medium: Detail; ws: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex aspect-video w-full max-w-md items-center justify-center overflow-hidden rounded-md bg-surface-sunken">
      {hasThumb(medium) && !broken ? (
        <img
          data-testid="detail-thumb"
          src={`/api/v1/workspaces/${ws}/media/${medium.id}/derivatives/thumb`}
          alt=""
          onError={() => setBroken(true)}
          className="size-full object-contain"
        />
      ) : (
        <KindIcon kind={kindOf(medium.mime)} testId="detail-icon" />
      )}
    </div>
  );
}

const GIGABYTE = ["gigabyte", 1e9] as const;
const SIZE_UNITS = [["byte", 1] as const, ["kilobyte", 1e3] as const, ["megabyte", 1e6] as const, GIGABYTE];

function useSizeWords() {
  const prefs = useFormatPrefs();
  const unit = (value: number, name: string) =>
    formatNumber(value, prefs, { style: "unit", unit: name, unitDisplay: "short", maximumFractionDigits: 1 });
  return {
    // The unit is picked after rounding, so 999,999 bytes reads 1 MB and never 1,000 kB.
    size: (bytes: number) => {
      const fits = ([, base]: (typeof SIZE_UNITS)[number]) => Math.round((bytes / base) * 10) / 10 < 1000;
      const [name, base] = SIZE_UNITS.find(fits) ?? GIGABYTE;
      return unit(bytes / base, name);
    },
    duration: (ms: number) => {
      const seconds = Math.round(ms / 1000);
      if (seconds < 60) return unit(ms / 1000, "second");
      return `${unit(Math.floor(seconds / 60), "minute")} ${unit(seconds % 60, "second")}`;
    },
    count: (value: number) => formatNumber(value, prefs),
  };
}

function Fact({
  testId,
  term,
  children,
}: {
  testId: string;
  term: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex flex-wrap gap-x-2">
      <dt className="font-medium">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Facts({ medium }: { medium: Detail }) {
  const { t } = useLingui();
  const words = useSizeWords();
  const count = medium.post_count;
  const shown = words.count(count);
  const { width, height, duration_ms: duration } = medium;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-heading text-lg">
        <Trans id="media.detail.facts">Details</Trans>
      </h2>
      <dl className="flex flex-col gap-1">
        <Fact testId="fact-size" term={<Trans id="media.detail.size">Size</Trans>}>
          <DirText dir="ltr">{words.size(medium.byte_size)}</DirText>
        </Fact>
        {width !== null && height !== null ? (
          <Fact testId="fact-dimensions" term={<Trans id="media.detail.dimensions">Dimensions</Trans>}>
            <DirText dir="ltr">{`${words.count(width)} × ${words.count(height)}`}</DirText>
          </Fact>
        ) : null}
        {kindOf(medium.mime) === "video" && duration !== null ? (
          <Fact testId="fact-duration" term={<Trans id="media.detail.duration">Length</Trans>}>
            {words.duration(duration)}
          </Fact>
        ) : null}
        <Fact testId="fact-created" term={<Trans id="media.detail.created">Added</Trans>}>
          <LocalizedDateTime value={new Date(medium.created_at)} timeZone={readZone()} />
        </Fact>
      </dl>
      <p data-testid="fact-posts">
        {t({
          id: "media.detail.posts",
          message: plural(count, {
            0: "No post uses this file",
            one: `Used in ${shown} post`,
            other: `Used in ${shown} posts`,
          }),
        })}
      </p>
    </section>
  );
}

function Copies({ medium }: { medium: Detail }) {
  const { i18n } = useLingui();
  const copies = Object.entries(medium.derivatives);
  if (copies.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-heading text-lg">
        <Trans id="media.detail.copies">Copies</Trans>
      </h2>
      <ul className="flex flex-col gap-1">
        {copies.map(([profile, state]) => (
          <li key={profile} data-testid="derivative" data-profile={profile} data-state={state}>
            {i18n._(copyWords(profile))}: {i18n._(copyStateWords(state))}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface FitRowsProps {
  state: FitReady;
  names: Map<string, string>;
  loadMore: () => void;
}

function FitRows({ state, names, loadMore }: FitRowsProps) {
  const { t, i18n } = useLingui();
  const ok = state.rows.filter((row) => row.ok).length;
  const total = state.rows.length;
  if (total === 0) {
    return (
      <p data-testid="fit-empty">
        <Trans id="media.fit.empty">No channel is connected yet.</Trans>
      </p>
    );
  }
  return (
    <>
      {state.next === null ? (
        <p data-testid="fit-summary">
          <Trans id="media.fit.summary">
            Channels this file fits: {ok} of {total}
          </Trans>
        </p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {state.rows.map((row, index) => {
          const n = index + 1;
          const name = names.get(row.channel_id);
          return (
            <li
              key={row.channel_id}
              data-testid="fit-row"
              data-channel={row.channel_id}
              data-ok={String(row.ok)}
              data-reason={row.reason}
              className="flex flex-wrap gap-x-2"
            >
              <span className="font-medium">
                {name === undefined ? (
                  t({ id: "media.fit.channel", message: `Channel ${n}` })
                ) : (
                  <DirText>{name}</DirText>
                )}
              </span>
              <span className={row.ok ? "" : "text-danger"}>
                {row.ok ? t({ id: "media.fit.ok", message: "Fits" }) : i18n._(fitWords(row.reason))}
              </span>
            </li>
          );
        })}
      </ul>
      {state.next === null ? null : (
        <div className="flex flex-col items-start gap-2">
          {state.more === "failed" ? (
            <p data-testid="fit-more-error" role="alert">
              <Trans id="media.fit.more_failed">We could not load more channels. Try again.</Trans>
            </p>
          ) : null}
          <Button data-testid="fit-more" busy={state.more === "busy"} onPress={loadMore}>
            <Trans id="media.more">Show more</Trans>
          </Button>
        </div>
      )}
    </>
  );
}

interface FitSectionProps {
  fit: ReturnType<typeof useFit>;
  names: Map<string, string>;
}

function FitSection({ fit, names }: FitSectionProps) {
  const { state } = fit;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-heading text-lg">
          <Trans id="media.fit.title">Where it fits</Trans>
        </h2>
        <Button data-testid="fit-reload" onPress={fit.checkAgain}>
          <Trans id="media.fit.check_again">Check again</Trans>
        </Button>
      </div>
      {state.status === "loading" ? (
        <p role="status">
          <Trans id="media.fit.loading">Checking your channels</Trans>
        </p>
      ) : null}
      {state.status === "failed" ? (
        <div data-testid="fit-error" role="alert">
          <ErrorPanel
            what={<Trans id="media.fit.failed.what">We could not check where this file fits</Trans>}
            meaning={<Trans id="media.fit.failed.meaning">The file is unchanged. Check again.</Trans>}
            error={state.error}
          />
        </div>
      ) : null}
      {state.status === "ready" ? <FitRows state={state} names={names} loadMore={fit.loadMore} /> : null}
    </section>
  );
}

function StateLine({ medium }: { medium: Detail }) {
  const { i18n } = useLingui();
  const known = stateOf(medium.state);
  const reason = reasonOf(medium.reject_reason);
  return (
    <p className="flex flex-wrap gap-x-2">
      <span data-testid="detail-state" data-state={known} className="font-medium">
        {i18n._(known === "unknown" ? UNKNOWN_STATE : STATE_WORDS[known])}
      </span>
      {medium.state === "rejected" ? (
        <span
          data-testid="detail-reason"
          data-reason={medium.reject_reason ?? "unknown"}
          className="text-danger"
        >
          {i18n._(reason === "unknown" ? UNKNOWN_REASON : REASON_WORDS[reason])}
        </span>
      ) : null}
    </p>
  );
}

function ReadyFit({ base, ws, notReady }: { base: string; ws: string; notReady: () => boolean }) {
  const fit = useFit(base, notReady);
  const names = useChannelNames(ws);
  if (fit.state.status === "gone") return <NotFoundPage />;
  return <FitSection fit={fit} names={names} />;
}

interface BodyProps {
  medium: Detail;
  read: number;
  ws: string;
  base: string;
  handlers: EditHandlers;
  notReady: () => boolean;
}

function Body({ medium, read, ws, base, handlers, notReady }: BodyProps) {
  return (
    <>
      <h1 data-testid="detail-name" className="font-heading text-2xl break-all">
        <DirText>{medium.file_name}</DirText>
      </h1>
      <StateLine medium={medium} />
      <MediaActions medium={medium} base={base} handlers={handlers} />
      <Preview key={medium.derivatives.thumb ?? "none"} medium={medium} ws={ws} />
      <Facts medium={medium} />
      <Copies medium={medium} />
      {medium.state === "ready" ? <ReadyFit key={read} base={base} ws={ws} notReady={notReady} /> : null}
    </>
  );
}

// While Try again runs, the old error is not shown as if it were the answer.
function Failed({ error, busy, retry }: { error: ApiError; busy: boolean; retry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      {busy ? null : (
        <ErrorPanel
          what={<Trans id="media.detail.failed.what">We could not load this file</Trans>}
          meaning={<Trans id="media.failed.meaning">Nothing was changed. Try again.</Trans>}
          error={error}
        />
      )}
      <Button data-testid="media-detail-retry" busy={busy} aria-disabled={busy} onPress={retry}>
        <Trans id="media.retry">Try again</Trans>
      </Button>
    </div>
  );
}

function BackLink({ ws, ref }: { ws: string; ref?: React.Ref<HTMLAnchorElement> }) {
  return (
    <Link
      ref={ref}
      data-testid="media-detail-back"
      to={`/w/${ws}/media`}
      className="inline-flex min-h-6 pointer-coarse:min-h-11 items-center self-start text-link underline"
    >
      <Trans id="media.detail.back">Back to the library</Trans>
    </Link>
  );
}

// A file deleted here or in another tab: focus moves to the way back, since the page it was on is gone.
function Gone({ ws }: { ws: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="flex flex-col gap-5">
      <BackLink ws={ws} ref={ref} />
      <NotFoundPage />
    </div>
  );
}

function MediaDetail({ ws, id }: { ws: string; id: string }) {
  const base = `/api/v1/workspaces/${ws}/media/${id}`;
  const { state, readAgain, notReady, show, gone } = useDetail(base);
  if (state.status === "gone") return <Gone ws={ws} />;
  if (state.status === "failed" && state.error.status === 404) return <NotFoundPage />;
  if (state.status === "failed" && state.error.state === "forbidden") return <ForbiddenPage />;
  return (
    <div data-testid="media-detail-state" data-state={state.status} className="flex flex-col gap-5">
      <BackLink ws={ws} />
      {state.status === "loading" ? (
        <Late label={<Trans id="media.detail.loading">Loading this file</Trans>}>
          <div
            data-testid="media-detail-skeleton"
            className="aspect-video w-full max-w-md rounded-md bg-surface-sunken"
          />
        </Late>
      ) : null}
      {state.status === "failed" ? <Failed error={state.error} busy={state.busy} retry={readAgain} /> : null}
      {state.status === "ready" ? (
        <Body
          medium={state.medium}
          read={state.read}
          ws={ws}
          base={base}
          handlers={{ onSaved: show, onGone: gone, readAgain }}
          notReady={notReady}
        />
      ) : null}
    </div>
  );
}

export function MediaDetailPage() {
  const { ws = "", id = "" } = useParams();
  const shell = useShellData();
  if (isUnknownWorkspace(shell, ws)) return <NotFoundPage />;
  return <MediaDetail key={`${ws}/${id}`} ws={ws} id={id} />;
}
