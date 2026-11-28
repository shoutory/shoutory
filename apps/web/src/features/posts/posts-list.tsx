import { Trans, useLingui } from "@lingui/react/macro";
import { ROLE_PERMISSIONS } from "@shoutory/core/authz";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { z } from "zod";
import { readZone } from "../../account/prefs";
import { ApiError, request } from "../../http/client";
import { ForbiddenPage, NotFoundPage } from "../../pages/system-pages";
import { isUnknownWorkspace, useShellData } from "../../shell/shell-data";
import { Button } from "../../ui/button";
import { DirText } from "../../ui/dir-text";
import { EmptyState } from "../../ui/empty-state";
import { ErrorPanel } from "../../ui/error-panel";
import { LocalizedDateTime, LocalizedNumber } from "../../ui/localized";
import { Select } from "../../ui/select";
import { dateOf } from "../channels/channel-facts";
import { useSignIn } from "../channels/channels-hub";
import { Late } from "../media/media-library";
import { factsOfList, headlineOf, type ListRow, listRowSchema, needsAPerson, wordOf } from "./post-facts";
import { type Names, useNames } from "./post-names";
import { HeadlineWord, Summary, TargetLabel } from "./post-words";

const pageSchema = z.object({
  data: z.array(listRowSchema),
  meta: z.object({ next_cursor: z.string().nullable() }),
});
type Page = z.infer<typeof pageSchema>;

// Needs attention has no server filter that covers a missed or media-held target, so it reads the newest posts in
// pages up to this bound and keeps the rows that need a person.
const ATTENTION_PAGE = 100;
const ATTENTION_PAGES = 5;
const STATUS_FILTERS = [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "partially_published",
  "failed",
  "missed",
  "archived",
] as const;
type Show = "all" | "attention" | (typeof STATUS_FILTERS)[number];

interface Ready {
  status: "ready";
  rows: ListRow[];
  next: string | null;
  more: "idle" | "busy" | "failed";
  /** How many posts Needs attention looked at when they did not end within the bound. */
  checked: number | null;
}
type ListState = { status: "loading" } | { status: "failed"; error: ApiError } | Ready;

const readPage = (ws: string, query: URLSearchParams) =>
  request(pageSchema, `/api/v1/workspaces/${ws}/posts${query.size > 0 ? `?${query}` : ""}`, {
    envelope: false,
  });

const showOf = (value: string | null): Show =>
  value === "attention" || (STATUS_FILTERS as readonly string[]).includes(value ?? "")
    ? (value as Show)
    : "all";

async function readAttention(ws: string): Promise<Ready> {
  const rows: ListRow[] = [];
  let cursor: string | null = null;
  let read = 0;
  let loaded = 0;
  do {
    const query = new URLSearchParams({ limit: String(ATTENTION_PAGE) });
    if (cursor !== null) query.set("cursor", cursor);
    const page: Page = await readPage(ws, query);
    loaded += page.data.length;
    rows.push(...page.data.filter((row) => row.targets.some((one) => needsAPerson(factsOfList(one)))));
    cursor = page.meta.next_cursor;
    read += 1;
  } while (cursor !== null && read < ATTENTION_PAGES);
  return { status: "ready", rows, next: null, more: "idle", checked: cursor === null ? null : loaded };
}

async function readFirst(ws: string, show: Show): Promise<Ready> {
  if (show === "attention") return readAttention(ws);
  const page = await readPage(ws, new URLSearchParams(show === "all" ? {} : { status: show }));
  return { status: "ready", rows: page.data, next: page.meta.next_cursor, more: "idle", checked: null };
}

function useList(ws: string, show: Show) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const moreBusy = useRef(false);
  // Each first read starts a new generation; the answer of a Show more from an earlier one is dropped.
  const generation = useRef(0);
  const expired = useSignIn();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry counter; `expired` follows the location.
  useEffect(() => {
    let live = true;
    generation.current += 1;
    moreBusy.current = false;
    setState({ status: "loading" });
    readFirst(ws, show).then(
      (ready) => live && setState(ready),
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
  }, [ws, show, attempt]);

  const loadMore = () => {
    if (state.status !== "ready" || state.next === null || moreBusy.current) return;
    moreBusy.current = true;
    setState({ ...state, more: "busy" });
    const mine = generation.current;
    const query = new URLSearchParams({ cursor: state.next });
    if (show !== "all") query.set("status", show);
    readPage(ws, query).then(
      (page) => {
        if (mine !== generation.current) return;
        moreBusy.current = false;
        setState((now) => {
          if (now.status !== "ready") return now;
          const known = new Set(now.rows.map((one) => one.id));
          const fresh = page.data.filter((one) => !known.has(one.id));
          return { ...now, rows: [...now.rows, ...fresh], next: page.meta.next_cursor, more: "idle" };
        });
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        moreBusy.current = false;
        setState((now) => (now.status === "ready" ? { ...now, more: "failed" } : now));
        if (!(error instanceof ApiError)) throw error;
        if (error.state === "session_expired") expired();
      },
    );
  };
  return { state, loadMore, retry: () => setAttempt((now) => now + 1) };
}

function RowTime({ row }: { row: ListRow }) {
  const waiting = row.targets
    .filter((one) => one.due_at !== null && wordOf(factsOfList(one)) === "pending")
    .flatMap((one) => {
      const at = dateOf(one.due_at);
      return at === null ? [] : [{ at, zone: one.due_tz ?? readZone() }];
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (waiting) {
    return (
      <Trans id="posts.row.goes_out">
        Goes out <LocalizedDateTime value={waiting.at} timeZone={waiting.zone} />
      </Trans>
    );
  }
  const published = row.targets
    .flatMap((one) => dateOf(one.published_at) ?? [])
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (published) {
    return (
      <Trans id="posts.row.published_at">
        Published <LocalizedDateTime value={published} timeZone={readZone()} />
      </Trans>
    );
  }
  const updated = dateOf(row.updated_at);
  if (updated === null) return null;
  return (
    <Trans id="posts.row.updated">
      Updated <LocalizedDateTime value={updated} timeZone={readZone()} />
    </Trans>
  );
}

function Author({ kind }: { kind: string }) {
  if (kind === "user") return <Trans id="posts.author.member">Member</Trans>;
  return kind === "service" ? <Trans id="posts.author.service">Automation</Trans> : null;
}

function Row({ row, ws, names }: { row: ListRow; ws: string; names: (id: string) => Names }) {
  const facts = row.targets.map(factsOfList);
  const headline = headlineOf(row.status, facts);
  return (
    <li
      data-testid="post-row"
      data-post-id={row.id}
      className="flex flex-col items-start gap-2 rounded-md border border-border px-5 py-4"
    >
      <Link to={`/w/${ws}/posts/${row.id}`} className="min-h-6 pointer-coarse:min-h-11 text-link underline">
        {row.excerpt ? <DirText>{row.excerpt}</DirText> : <Trans id="posts.row.no_text">No text yet</Trans>}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <span data-testid="post-headline" className="font-medium">
          <HeadlineWord headline={headline} />
        </span>
        {facts.some(needsAPerson) ? (
          <span data-testid="post-attention" className="rounded-full border border-danger px-3 text-sm">
            <Trans id="posts.row.attention">Needs you</Trans>
          </span>
        ) : null}
      </div>
      {headline.m > 1 ? (
        <p data-testid="post-summary" className="text-sm">
          <Summary headline={headline} />
        </p>
      ) : null}
      <ul className="flex flex-col gap-1 text-sm">
        {row.targets.map((one) => {
          const named = names(one.channel_id);
          return (
            <li key={one.variant_id} data-testid="post-target">
              <DirText>{named.channel}</DirText>
              {": "}
              <TargetLabel
                word={wordOf(factsOfList(one))}
                provider={named.provider}
                channel={named.channel}
              />
            </li>
          );
        })}
      </ul>
      <span className="text-sm text-text-muted">
        <RowTime row={row} /> · <Author kind={row.author_kind} />
      </span>
    </li>
  );
}

function Skeleton() {
  return (
    <Late label={<Trans id="posts.loading">Loading your posts</Trans>}>
      <div data-testid="posts-skeleton" className="flex flex-col gap-3">
        {["a", "b", "c"].map((key) => (
          <div key={key} className="h-24 rounded-md bg-surface-sunken" />
        ))}
      </div>
    </Late>
  );
}

function Failed({ error, retry }: { error: ApiError; retry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <ErrorPanel
        what={<Trans id="posts.failed.what">We could not load your posts</Trans>}
        meaning={<Trans id="posts.failed.meaning">Nothing was changed. Try again.</Trans>}
        error={error}
      />
      <Button data-testid="posts-retry" onPress={retry}>
        <Trans id="posts.retry">Try again</Trans>
      </Button>
    </div>
  );
}

function Empty({ show, canCompose, clear }: { show: Show; canCompose: boolean; clear: () => void }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { ws = "" } = useParams();
  if (show === "attention") {
    return (
      <EmptyState kind="cleared" title={<Trans id="posts.empty.cleared">Nothing needs you</Trans>}>
        <Trans id="posts.empty.cleared_meaning">No post is waiting for your check right now.</Trans>
      </EmptyState>
    );
  }
  if (show !== "all") {
    return (
      <EmptyState
        kind="filtered-out"
        title={<Trans id="posts.empty.filtered">No posts match these filters</Trans>}
        onClearFilters={clear}
      />
    );
  }
  return (
    <EmptyState
      kind="first-use"
      title={<Trans id="posts.empty.first">No posts yet</Trans>}
      {...(canCompose
        ? {
            action: {
              label: t({ id: "posts.new", message: "New post" }),
              onPress: () => void navigate(`/w/${ws}/posts/new`),
              testId: "posts-empty-new",
            },
          }
        : {})}
    >
      <Trans id="posts.empty.first_meaning">Posts you write for your channels show here.</Trans>
    </EmptyState>
  );
}

function Rows({ state, ws, loadMore }: { state: Ready; ws: string; loadMore: () => void }) {
  const names = useNames(ws);
  return (
    <>
      <ul className="flex flex-col gap-3">
        {state.rows.map((row) => (
          <Row key={row.id} row={row} ws={ws} names={names} />
        ))}
      </ul>
      {state.next === null ? null : (
        <div className="flex flex-col items-start gap-3">
          {state.more === "failed" ? (
            <p data-testid="posts-more-error" role="alert">
              <Trans id="posts.more_failed">
                We could not load more posts. The ones above are still current. Try again.
              </Trans>
            </p>
          ) : null}
          <Button data-testid="posts-more" busy={state.more === "busy"} onPress={loadMore}>
            <Trans id="posts.more">Show more</Trans>
          </Button>
        </div>
      )}
    </>
  );
}

function Filter({ show, onChange }: { show: Show; onChange: (show: Show) => void }) {
  const { t } = useLingui();
  const words: Record<Show, string> = {
    all: t({ id: "posts.filter.all", message: "All posts" }),
    attention: t({ id: "posts.filter.attention", message: "Needs attention" }),
    draft: t({ id: "posts.headline.draft", message: "Draft" }),
    in_review: t({ id: "posts.headline.in_review", message: "In review" }),
    changes_requested: t({ id: "posts.headline.changes_requested", message: "Changes requested" }),
    approved: t({ id: "posts.headline.approved", message: "Approved" }),
    scheduled: t({ id: "posts.headline.scheduled", message: "Scheduled" }),
    publishing: t({ id: "posts.headline.publishing", message: "Publishing" }),
    published: t({ id: "posts.headline.published", message: "Published" }),
    partially_published: t({ id: "posts.headline.partly", message: "Partly published" }),
    failed: t({ id: "posts.headline.failed", message: "Failed" }),
    missed: t({ id: "posts.headline.missed", message: "Missed" }),
    archived: t({ id: "posts.headline.archived", message: "Archived" }),
  };
  return (
    <Select
      testId="posts-filter"
      label={t({ id: "posts.filter.label", message: "Show" })}
      value={show}
      onChange={(value) => onChange(showOf(value))}
      options={(Object.keys(words) as Show[]).map((value) => ({ value, label: words[value] }))}
    />
  );
}

const stateName = (state: ListState, show: Show) => {
  if (state.status !== "ready") return state.status;
  if (state.rows.length > 0) return "list";
  if (show === "attention") return "cleared";
  return show === "all" ? "empty" : "filtered";
};

function Posts({ ws }: { ws: string }) {
  const [params, setParams] = useSearchParams();
  const show = showOf(params.get("show"));
  const { state, loadMore, retry } = useList(ws, show);
  const data = useShellData();
  const role = "error" in data ? undefined : data.workspaces.find((one) => one.id === ws)?.role;
  const permissions: Readonly<Record<string, readonly string[] | undefined>> = ROLE_PERMISSIONS;
  const canCompose = role !== undefined && (permissions[role]?.includes("posts.edit") ?? false);
  if (state.status === "failed" && state.error.state === "forbidden") return <ForbiddenPage />;
  const choose = (next: Show) => setParams(next === "all" ? {} : { show: next });
  return (
    <div data-testid="posts-state" data-state={stateName(state, show)} className="flex flex-col gap-5">
      <h1 className="font-heading text-2xl">
        <Trans id="posts.title">Posts</Trans>
      </h1>
      <div className="flex flex-wrap items-end gap-5">
        <Filter show={show} onChange={choose} />
        {canCompose ? (
          <Link
            to={`/w/${ws}/posts/new`}
            data-testid="posts-new"
            className="inline-flex min-h-10 pointer-coarse:min-h-11 items-center rounded-md border border-border-control bg-primary px-5 text-md font-medium text-on-primary"
          >
            <Trans id="posts.new">New post</Trans>
          </Link>
        ) : null}
      </div>
      {state.status === "loading" ? <Skeleton /> : null}
      {state.status === "failed" ? <Failed error={state.error} retry={retry} /> : null}
      {state.status === "ready" && state.rows.length === 0 ? (
        <Empty show={show} canCompose={canCompose} clear={() => choose("all")} />
      ) : null}
      {state.status === "ready" && state.rows.length > 0 ? (
        <Rows state={state} ws={ws} loadMore={loadMore} />
      ) : null}
      {state.status === "ready" && state.checked !== null ? (
        <p data-testid="posts-checked-note" className="text-sm">
          <Trans id="posts.checked_note">
            Only the newest <LocalizedNumber value={state.checked} /> posts were checked for this view.
          </Trans>
        </p>
      ) : null}
    </div>
  );
}

export function PostsPage() {
  const { ws = "" } = useParams();
  const shell = useShellData();
  if (isUnknownWorkspace(shell, ws)) return <NotFoundPage />;
  return <Posts key={ws} ws={ws} />;
}
