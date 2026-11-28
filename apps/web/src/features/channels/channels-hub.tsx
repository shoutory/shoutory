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
import { Link, useLocation, useNavigate, useParams } from "react-router";
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
import { Switch } from "../../ui/switch";
import {
  CapabilityChips,
  type Channel,
  channelSchema,
  dateOf,
  ExpiryHint,
  type ProviderInfo,
  RECONNECTABLE,
  useProviderNames,
  useWords,
  type Words,
} from "./channel-facts";
import { ReconnectSecret } from "./connect-secret";
import { Reconnect } from "./connect-start";
import { ConnectWizard } from "./connect-wizard";

const pageSchema = z.object({
  data: z.array(channelSchema),
  // Connecting is offered only when the server lists `connect`; the client never derives it.
  meta: z.object({ next_cursor: z.uuid().nullable(), actions: z.array(z.string()) }),
});
type Page = z.infer<typeof pageSchema>;

interface Ready {
  status: "ready";
  rows: Channel[];
  next: string | null;
  more: "idle" | "busy" | "failed";
  /** The card that takes focus: the first one a last page appended, because Show more is gone. */
  focusId: string | null;
  canConnect: boolean;
}
type ListState = { status: "loading" } | { status: "failed"; error: ApiError } | Ready;

const readPage = (base: string, cursor?: string) =>
  request(pageSchema, cursor === undefined ? base : `${base}?cursor=${cursor}`, { envelope: false });

const firstPage = (page: Page): Ready => ({
  status: "ready",
  rows: page.data,
  next: page.meta.next_cursor,
  more: "idle",
  focusId: null,
  canConnect: page.meta.actions.includes("connect"),
});

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

export function useSignIn() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  return () => void navigate(`/sign-in?return-to=${encodeURIComponent(pathname + search)}`);
}

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

function initialsOf(name: string): string {
  const words = name
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2);
  if (words.length === 0) return "?";
  return words.map((word) => ([...word][0] ?? "").toUpperCase()).join("");
}

// "ok" needs a check time behind it, so a healthy word is never shown without one.
function healthOf(row: Channel): "ok" | "degraded" | "failing" | "unknown" | null {
  if (row.connection_state !== "connected") return null;
  if (row.health === "degraded" || row.health === "failing") return row.health;
  return row.health === "ok" && dateOf(row.health_checked_at) !== null ? "ok" : "unknown";
}

interface CardContext {
  names: ReadonlyMap<string, ProviderInfo>;
  words: Words;
  zone: string;
  ws: string;
  onReplace: (row: Channel) => void;
  onDrop: (id: string) => void;
  onConnected: () => void;
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

// A second press while one is pending is ignored (Button `busy` only marks the button). The failure line outlives a
// card replacement, so this hook is mounted whether or not the button is offered.
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
  // When the fresh row no longer offers Check now, focus moves to the card, not to the page.
  const replace = (fresh: Channel) => {
    context.onReplace(fresh);
    if (!fresh.actions.includes("check")) focusCard();
  };
  // Release the press before rethrowing, or the button stays stuck.
  const refused = (error: unknown): ApiError => {
    if (error instanceof ApiError) return error;
    release();
    throw error;
  };
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
        <Link
          to={`/w/${context.ws}/channels/${row.id}`}
          className="inline-flex min-h-6 pointer-coarse:min-h-11 items-center text-link underline"
        >
          <DirText>{row.display_name}</DirText>
        </Link>
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
        <DirText>{context.names.get(row.provider_id)?.name ?? row.provider_id}</DirText>
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
      <ExpiryHint row={row} zone={zone} />
    </>
  );
}

// A channel made from a pasted secret is reconnected by pasting it again, never through an authorization.
export function ReconnectOf(props: {
  row: Channel;
  info: ProviderInfo | undefined;
  ws: string;
  nameId: string;
  onConnected: () => void;
}) {
  const { row, info, ws, nameId } = props;
  if (info?.secretKind) {
    const platform = { id: row.provider_id, display_name: info.name, secret_kind: info.secretKind };
    return (
      <ReconnectSecret
        ws={ws}
        platform={platform}
        channelId={row.id}
        nameId={nameId}
        onDone={props.onConnected}
      />
    );
  }
  return <Reconnect ws={ws} providerId={row.provider_id} channelId={row.id} nameId={nameId} />;
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
        <CapabilityChips info={context.names.get(row.provider_id)} words={context.words} />
        <CheckNow row={row} context={context} nameId={nameId} focusCard={() => ref.current?.focus()} />
        {row.actions.includes("reconnect") ? (
          <ReconnectOf
            row={row}
            info={context.names.get(row.provider_id)}
            ws={context.ws}
            nameId={nameId}
            onConnected={context.onConnected}
          />
        ) : null}
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

interface LoadedProps {
  state: Ready;
  context: CardContext;
  attention: boolean;
  loadMore: () => void;
  onAdd: () => void;
  onClearFilter: () => void;
}

// The server's own words decide: a channel that is not connected, or that offers a reconnect. A channel the person
// turned off is where they left it, not something that needs them.
const needsAttention = (row: Channel) =>
  (row.connection_state !== "connected" && row.connection_state !== "disabled") ||
  row.actions.includes("reconnect");

interface Group {
  readonly key: string;
  readonly name: string;
  readonly rows: Channel[];
}

function groupsOf(rows: readonly Channel[], names: ReadonlyMap<string, ProviderInfo>): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const group = groups.get(row.provider_id) ?? {
      key: row.provider_id,
      name: names.get(row.provider_id)?.name ?? row.provider_id,
      rows: [],
    };
    group.rows.push(row);
    groups.set(row.provider_id, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function PlatformGroup({ group, state, context }: { group: Group; state: Ready; context: CardContext }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-heading text-lg">
        <DirText>{group.name}</DirText>
      </h2>
      <ul className="flex flex-col gap-3">
        {group.rows.map((row) => (
          <Card key={row.id} row={row} context={context} focus={row.id === state.focusId} />
        ))}
      </ul>
    </section>
  );
}

function Loaded({ state, context, attention, loadMore, onAdd, onClearFilter }: LoadedProps) {
  const { t } = useLingui();
  if (state.rows.length === 0) {
    const add = {
      label: t({ id: "channels.hub.add", message: "Add channel" }),
      onPress: onAdd,
      testId: "hub-add-empty",
    };
    return (
      <EmptyState
        kind="first-use"
        title={<Trans id="channels.hub.empty.title">No channels yet</Trans>}
        {...(state.canConnect ? { action: add } : {})}
      >
        <Trans id="channels.hub.empty.meaning">
          Channels you connect to this workspace will appear here.
        </Trans>
      </EmptyState>
    );
  }
  const shown = attention ? state.rows.filter(needsAttention) : state.rows;
  return (
    <>
      {shown.length === 0 ? (
        <EmptyState
          kind="filtered-out"
          title={<Trans id="channels.hub.no_match">No channels match</Trans>}
          onClearFilters={onClearFilter}
        >
          <Trans id="channels.hub.no_match_meaning">Every channel loaded so far is connected.</Trans>
        </EmptyState>
      ) : (
        groupsOf(shown, context.names).map((group) => (
          <PlatformGroup key={group.key} group={group} state={state} context={context} />
        ))
      )}
      <ShowMore state={state} loadMore={loadMore} />
    </>
  );
}

// Closing the dialog returns focus to the button, also where the press did not focus it first.
function useAddDialog() {
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !adding) addRef.current?.focus();
    wasOpen.current = adding;
  }, [adding]);
  return { adding, setAdding, addRef };
}

// Keyed by the workspace (see the page), so nothing of the old workspace can reach the new one.
function ChannelsHub({ ws }: { ws: string }) {
  const { state, loadMore, retry, replaceRow, dropRow } = useChannelList(ws);
  const [removed, setRemoved] = useState(false);
  const [attention, setAttention] = useState(false);
  const { adding, setAdding, addRef } = useAddDialog();
  const canConnect = state.status === "ready" && state.canConnect;
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
    onConnected: () => connected(),
  };
  const tryAgain = () => {
    setRemoved(false);
    retry();
  };
  const connected = () => {
    setAdding(false);
    tryAgain();
  };
  return (
    <div data-testid="hub-state" data-state={stateName(state)} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 data-testid="hub-heading" className="font-heading text-2xl">
          <Trans id="channels.hub.title">Channels</Trans>
        </h1>
        {canConnect ? (
          <Button ref={addRef} data-testid="hub-add" onPress={() => setAdding(true)}>
            <Trans id="channels.hub.add">Add channel</Trans>
          </Button>
        ) : null}
      </div>
      {canConnect ? (
        <ConnectWizard ws={ws} isOpen={adding} onOpenChange={setAdding} onConnected={connected} />
      ) : null}
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
      {state.status === "ready" && state.rows.length > 0 ? (
        <Switch
          label={<Trans id="channels.hub.filter_attention">Needs attention</Trans>}
          isSelected={attention}
          onChange={setAttention}
        />
      ) : null}
      {state.status === "ready" ? (
        <Loaded
          state={state}
          context={context}
          attention={attention}
          loadMore={loadMore}
          onAdd={() => setAdding(true)}
          onClearFilter={() => setAttention(false)}
        />
      ) : null}
    </div>
  );
}

export function ChannelsHubPage() {
  const { ws = "" } = useParams();
  const shell = useShellData();
  if (isUnknownWorkspace(shell, ws)) return <NotFoundPage />;
  return <ChannelsHub key={ws} ws={ws} />;
}
