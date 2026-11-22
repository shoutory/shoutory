import { Trans, useLingui } from "@lingui/react/macro";
import { CONNECTION_STATES } from "@shoutory/core/channels/state";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { readZone } from "../../account/prefs";
import { ApiError, request } from "../../http/client";
import { NotFoundPage } from "../../pages/system-pages";
import { isUnknownWorkspace, useShellData } from "../../shell/shell-data";
import { Button } from "../../ui/button";
import { DirText } from "../../ui/dir-text";
import { EmptyState } from "../../ui/empty-state";
import { ErrorPanel } from "../../ui/error-panel";
import { LocalizedDateTime } from "../../ui/localized";

// H-01: the paged list of a workspace's channels. The list is this page's own state (it pages by cursor and replaces
// one row at a time); only `next_cursor` of the answer's `meta` is read.

const channelSchema = z.object({
  id: z.uuid(),
  provider_id: z.string(),
  display_name: z.string(),
  nickname: z.string().nullable(),
  handle: z.string().nullable(),
  connection_state: z.string(),
  health: z.string().nullable(),
  health_checked_at: z.string().nullable(),
  reconnect_deadline: z.string().nullable(),
  // Only `check` is read: the other actions belong to screens that do not exist yet.
  actions: z.array(z.string()),
});
type Channel = z.infer<typeof channelSchema>;
const pageSchema = z.object({
  data: z.array(channelSchema),
  meta: z.object({ next_cursor: z.uuid().nullable() }),
});
type Page = z.infer<typeof pageSchema>;

interface Ready {
  status: "ready";
  rows: Channel[];
  next: string | null;
  more: "idle" | "busy" | "failed";
  /** The card that takes focus: the first one a last page appended, because Show more is gone. */
  focusId: string | null;
}
type ListState = { status: "loading" } | { status: "failed"; error: ApiError } | Ready;

// One page of the list: the first, or the one after `cursor`. An answer that is not a page is a failed read.
const readPage = (base: string, cursor?: string) =>
  request(pageSchema, cursor === undefined ? base : `${base}?cursor=${cursor}`, { envelope: false });

const firstPage = (page: Page): Ready => ({
  status: "ready",
  rows: page.data,
  next: page.meta.next_cursor,
  more: "idle",
  focusId: null,
});

// The next page adds only channels not listed yet, whatever the server repeats.
function appended(now: Ready, page: Page): Ready {
  const known = new Set(now.rows.map((one) => one.id));
  const fresh = page.data.filter((one) => !known.has(one.id));
  const last = page.meta.next_cursor === null;
  return {
    ...now,
    rows: [...now.rows, ...fresh],
    next: page.meta.next_cursor,
    more: "idle",
    focusId: last ? (fresh[0]?.id ?? null) : null,
  };
}

// The session ended while the page was open: sign in, then come back to this address.
function useSignIn() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  return () => void navigate(`/sign-in?return-to=${encodeURIComponent(pathname + search)}`);
}

// Changes the rows of a loaded list; a list that is not loaded is left alone.
const onRows = (set: Dispatch<SetStateAction<ListState>>, change: (rows: Channel[]) => Channel[]) =>
  set((now) => (now.status === "ready" ? { ...now, rows: change(now.rows) } : now));

function useChannelList(ws: string) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const moreBusy = useRef(false);
  const expired = useSignIn();
  const base = `/api/v1/workspaces/${ws}/channels`;

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
        setState((now) => (now.status === "ready" ? appended(now, page) : now));
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
  const replaceRow = (fresh: Channel) =>
    onRows(setState, (rows) => rows.map((one) => (one.id === fresh.id ? fresh : one)));
  const dropRow = (id: string) => onRows(setState, (rows) => rows.filter((one) => one.id !== id));
  return { state, loadMore, retry, replaceRow, dropRow };
}

function Failed({ error, retry }: { error: ApiError; retry: () => void }) {
  const forbidden = error.state === "forbidden";
  return (
    <div className="flex flex-col items-start gap-3">
      <ErrorPanel
        what={
          forbidden ? (
            <Trans id="channels.hub.forbidden.what">You cannot see this workspace's channels</Trans>
          ) : (
            <Trans id="channels.hub.failed.what">We could not load your channels</Trans>
          )
        }
        meaning={
          forbidden ? (
            <Trans id="channels.hub.forbidden.meaning">
              Your role does not include channels. Ask an owner or admin of this workspace.
            </Trans>
          ) : (
            <Trans id="channels.hub.failed.meaning">Nothing was changed. Try again.</Trans>
          )
        }
        error={error}
      />
      {forbidden ? null : (
        <Button data-testid="hub-retry" onPress={retry}>
          <Trans id="channels.hub.retry">Try again</Trans>
        </Button>
      )}
    </div>
  );
}

const providersSchema = z.array(z.object({ id: z.string(), display_name: z.string() }));

// The providers read names each card's provider; its failure never fails the hub, the card then shows the id.
function useProviderNames(ws: string): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    request(providersSchema, `/api/v1/workspaces/${ws}/providers`).then(
      (providers) => live && setNames(new Map(providers.map((one) => [one.id, one.display_name]))),
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
      },
    );
    return () => {
      live = false;
    };
  }, [ws]);
  return names;
}

// One word per state and per health (UX 6.3 C); a value the page does not know has the unknown word, never Connected.
function useWords() {
  const { t } = useLingui();
  return {
    state: new Map([
      ["connected", t({ id: "channels.hub.state.connected", message: "Connected" })],
      ["needs_reconnect", t({ id: "connect.result.state.needs_reconnect", message: "Reconnect needed" })],
      ["disconnected", t({ id: "connect.result.state.disconnected", message: "Disconnected" })],
      [
        "revoked_by_provider",
        t({ id: "connect.result.state.revoked_by_provider", message: "Access removed" }),
      ],
      ["disabled", t({ id: "connect.result.state.disabled", message: "Turned off" })],
    ]),
    unknownState: t({ id: "connect.result.state.unknown", message: "Unknown" }),
    health: new Map([
      ["ok", t({ id: "channels.hub.health.ok", message: "Healthy" })],
      ["degraded", t({ id: "channels.hub.health.degraded", message: "Slow or limited" })],
      ["failing", t({ id: "channels.hub.health.failing", message: "Failing" })],
      ["unknown", t({ id: "channels.hub.health.unknown", message: "Not checked yet" })],
    ]),
  };
}
type Words = ReturnType<typeof useWords>;

// The first code point of each of the first two words; nothing to show reads "?".
function initialsOf(name: string): string {
  const words = name
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2);
  if (words.length === 0) return "?";
  return words.map((word) => ([...word][0] ?? "").toUpperCase()).join("");
}

// Health is read only on a connected channel; "ok" needs a check time behind it, an unfavourable word claims nothing.
function healthOf(row: Channel): "ok" | "degraded" | "failing" | "unknown" | null {
  if (row.connection_state !== "connected") return null;
  if (row.health === "degraded" || row.health === "failing") return row.health;
  return row.health === "ok" && dateOf(row.health_checked_at) !== null ? "ok" : "unknown";
}

const dateOf = (value: string | null): Date | null => {
  const date = value === null ? null : new Date(value);
  return date === null || Number.isNaN(date.getTime()) ? null : date;
};
const RECONNECTABLE = new Set(["needs_reconnect", "disconnected", "revoked_by_provider"]);

interface CardContext {
  names: ReadonlyMap<string, string>;
  words: Words;
  zone: string;
  ws: string;
  /** A check or a fresh read answered this row: it replaces the card. */
  onReplace: (row: Channel) => void;
  /** The channel is gone: the card is dropped. */
  onDrop: (id: string) => void;
}

type CheckFailure = "not_connected" | "provider_unavailable" | "rate_limited" | "forbidden" | "failed";
const CHECK_WORDS: Record<CheckFailure | "not_found", ReactNode> = {
  not_connected: (
    <Trans id="channels.hub.check.not_connected">
      This channel is no longer connected. Its card now shows its current state.
    </Trans>
  ),
  provider_unavailable: (
    <Trans id="channels.hub.check.provider_unavailable">
      The platform is not answering right now. Nothing was changed. Try again later.
    </Trans>
  ),
  rate_limited: (
    <Trans id="channels.hub.check.rate_limited">Too many checks. Wait a few minutes, then check again.</Trans>
  ),
  forbidden: (
    <Trans id="channels.hub.check.forbidden">
      You cannot check this channel. Ask an owner or admin of this workspace.
    </Trans>
  ),
  not_found: (
    <Trans id="channels.hub.check.not_found">This channel was removed. It is no longer in the list.</Trans>
  ),
  failed: (
    <Trans id="channels.hub.check.failed">
      We could not check this channel. Nothing was changed. Try again.
    </Trans>
  ),
};

function failureOf(error: ApiError): CheckFailure | "not_found" {
  if (error.state === "not_found") return "not_found";
  if (error.state === "forbidden") return "forbidden";
  if (error.status === 429) return "rate_limited";
  const reason = error.status === 409 ? error.details?.reason : undefined;
  return reason === "not_connected" || reason === "provider_unavailable" ? reason : "failed";
}

// Check now only reads. A second press while one is pending is ignored (Button `busy` only marks the button); the line
// of a failure stays when the card is replaced, so this part is mounted whether or not the button is offered.
function useCheck(row: Channel, context: CardContext, focusCard: () => void) {
  const [failure, setFailure] = useState<CheckFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const pressed = useRef(false);
  const expired = useSignIn();
  const base = `/api/v1/workspaces/${context.ws}/channels/${row.id}`;

  const release = () => {
    pressed.current = false;
    setBusy(false);
  };
  // A fresh row replaces the card; when it no longer offers Check now, focus moves to the card, not to the page.
  const replace = (fresh: Channel) => {
    context.onReplace(fresh);
    if (!fresh.actions.includes("check")) focusCard();
  };
  // A rejection that is not an ApiError is a bug: the press is let go before it is rethrown.
  const refused = (error: unknown): ApiError => {
    if (error instanceof ApiError) return error;
    release();
    throw error;
  };
  // The fresh read after "no longer connected": a 404 drops the card, any other failure is the other failure line.
  const fail = (error: unknown, afterRefresh: boolean) => {
    const answer = refused(error);
    release();
    const why = failureOf(answer);
    if (answer.state === "session_expired") return expired();
    if (why === "not_found") return context.onDrop(row.id);
    setFailure(afterRefresh ? "failed" : why);
    if (why === "not_connected" && !afterRefresh) {
      request(channelSchema, base).then(replace, (next: unknown) => fail(next, true));
    }
  };
  const press = () => {
    if (pressed.current) return;
    pressed.current = true;
    setBusy(true);
    setFailure(null);
    request(channelSchema, `${base}/check`, { method: "POST" }).then(
      (fresh) => {
        release();
        replace(fresh);
      },
      (error: unknown) => fail(error, false),
    );
  };
  return { failure, busy, press };
}

interface CheckProps {
  row: Channel;
  context: CardContext;
  /** The id of the card's display name, which describes the button. */
  nameId: string;
  focusCard: () => void;
}

function CheckNow({ row, context, nameId, focusCard }: CheckProps) {
  const { failure, busy, press } = useCheck(row, context, focusCard);
  return (
    <>
      {row.actions.includes("check") ? (
        <Button data-testid="card-check" aria-describedby={nameId} busy={busy} onPress={press}>
          <Trans id="channels.hub.check">Check now</Trans>
        </Button>
      ) : null}
      {failure === null ? null : (
        <p data-testid="card-check-error" data-reason={failure} role="alert" className="text-sm">
          {CHECK_WORDS[failure]}
        </p>
      )}
    </>
  );
}

function Names({ row, context, nameId }: { row: Channel; context: CardContext; nameId: string }) {
  return (
    <>
      <span id={nameId} data-testid="card-display-name" className="text-md font-medium">
        <DirText>{row.display_name}</DirText>
      </span>
      {row.nickname === null ? null : (
        <span data-testid="card-nickname">
          <DirText>{row.nickname}</DirText>
        </span>
      )}
      {row.handle === null ? null : (
        <span data-testid="card-handle">
          <DirText dir="ltr">{row.handle}</DirText>
        </span>
      )}
      <span data-testid="card-provider" className="text-sm text-text-muted">
        <DirText>{context.names.get(row.provider_id) ?? row.provider_id}</DirText>
      </span>
    </>
  );
}

function Status({ row, context }: { row: Channel; context: CardContext }) {
  const { words, zone } = context;
  const state = CONNECTION_STATES.find((known) => known === row.connection_state) ?? "unknown";
  const health = healthOf(row);
  const checked = health === null || health === "unknown" ? null : dateOf(row.health_checked_at);
  const deadline = RECONNECTABLE.has(state) ? dateOf(row.reconnect_deadline) : null;
  return (
    <>
      <span data-testid="card-state" data-state={state}>
        {words.state.get(state) ?? words.unknownState}
      </span>
      {health === null ? null : (
        <span data-testid="card-health" data-health={health}>
          {words.health.get(health)}
        </span>
      )}
      {checked === null ? null : (
        <span data-testid="card-checked" className="text-sm text-text-muted">
          <Trans id="channels.hub.checked">
            Checked <LocalizedDateTime value={checked} timeZone={zone} />
          </Trans>
        </span>
      )}
      {deadline === null ? null : (
        <span data-testid="card-deadline" className="text-sm">
          <Trans id="channels.hub.deadline">
            Reconnect by <LocalizedDateTime value={deadline} timeZone={zone} />
          </Trans>
        </span>
      )}
    </>
  );
}

function Card({ row, context, focus }: { row: Channel; context: CardContext; focus: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  const nameId = useId();
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <li
      ref={ref}
      tabIndex={-1}
      data-testid="channel-card"
      data-channel-id={row.id}
      className="flex flex-wrap items-start gap-3 rounded-md border border-border px-5 py-4 outline-offset-2"
    >
      <span
        aria-hidden="true"
        data-testid="card-initials"
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-sunken font-medium"
      >
        {initialsOf(row.display_name)}
      </span>
      <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1">
        <Names row={row} context={context} nameId={nameId} />
        <Status row={row} context={context} />
        <CheckNow row={row} context={context} nameId={nameId} focusCard={() => ref.current?.focus()} />
      </div>
    </li>
  );
}

const stateName = (state: ListState) => {
  if (state.status === "failed") return state.error.state === "forbidden" ? "forbidden" : "failed";
  if (state.status === "ready") return state.rows.length === 0 ? "empty" : "list";
  return "loading";
};

function ShowMore({ state, loadMore }: { state: Ready; loadMore: () => void }) {
  if (state.next === null) return null;
  return (
    <div className="flex flex-col items-start gap-3">
      {state.more === "failed" ? (
        <p data-testid="hub-more-error" role="alert">
          <Trans id="channels.hub.more_failed">
            We could not load more channels. The ones above are still current. Try again.
          </Trans>
        </p>
      ) : null}
      <Button data-testid="hub-more" busy={state.more === "busy"} onPress={loadMore}>
        <Trans id="channels.hub.more">Show more</Trans>
      </Button>
    </div>
  );
}

function Loaded({ state, context, loadMore }: { state: Ready; context: CardContext; loadMore: () => void }) {
  if (state.rows.length === 0) {
    return (
      <EmptyState kind="first-use" title={<Trans id="channels.hub.empty.title">No channels yet</Trans>}>
        <Trans id="channels.hub.empty.meaning">
          Channels you connect to this workspace will appear here.
        </Trans>
      </EmptyState>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-3">
        {state.rows.map((row) => (
          <Card key={row.id} row={row} context={context} focus={row.id === state.focusId} />
        ))}
      </ul>
      <ShowMore state={state} loadMore={loadMore} />
    </>
  );
}

// Keyed by the workspace (see the page), so a change of workspace starts from nothing: no row, page, notice or answer
// of the old one can reach the new one.
function ChannelsHub({ ws }: { ws: string }) {
  const { state, loadMore, retry, replaceRow, dropRow } = useChannelList(ws);
  const [removed, setRemoved] = useState(false);
  const context = {
    names: useProviderNames(ws),
    words: useWords(),
    zone: readZone(),
    ws,
    onReplace: replaceRow,
    onDrop: (id: string) => {
      dropRow(id);
      setRemoved(true);
    },
  };
  const tryAgain = () => {
    setRemoved(false);
    retry();
  };
  return (
    <div data-testid="hub-state" data-state={stateName(state)} className="flex flex-col gap-5">
      <h1 data-testid="hub-heading" className="font-heading text-2xl">
        <Trans id="channels.hub.title">Channels</Trans>
      </h1>
      {removed ? (
        <p data-testid="hub-notice" data-reason="not_found" role="status">
          {CHECK_WORDS.not_found}
        </p>
      ) : null}
      {state.status === "loading" ? (
        <div role="status" aria-busy="true">
          <Trans id="channels.hub.loading">Loading your channels</Trans>
        </div>
      ) : null}
      {state.status === "failed" ? <Failed error={state.error} retry={tryAgain} /> : null}
      {state.status === "ready" ? <Loaded state={state} context={context} loadMore={loadMore} /> : null}
    </div>
  );
}

/** `/w/:ws/channels`: a workspace that is not one of mine is the not-found page and reads nothing. */
export function ChannelsHubPage() {
  const { ws = "" } = useParams();
  const shell = useShellData();
  if (isUnknownWorkspace(shell, ws)) return <NotFoundPage />;
  return <ChannelsHub key={ws} ws={ws} />;
}
