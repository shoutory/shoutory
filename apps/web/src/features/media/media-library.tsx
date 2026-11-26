import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import {
  Checkbox,
  GridList,
  GridListItem,
  Input,
  Label,
  Button as PlainButton,
  SearchField,
} from "react-aria-components";
import { Link, useParams } from "react-router";
import { z } from "zod";
import { type ApiError, request } from "../../http/client";
import { ForbiddenPage, NotFoundPage } from "../../pages/system-pages";
import { isUnknownWorkspace, useShellData } from "../../shell/shell-data";
import { Button } from "../../ui/button";
import { DirText } from "../../ui/dir-text";
import { EmptyState } from "../../ui/empty-state";
import { ErrorPanel } from "../../ui/error-panel";
import { Select } from "../../ui/select";
import { useSignIn } from "../channels/channels-hub";
import {
  asApiError,
  hasThumb,
  kindOf,
  LISTED_STATES,
  type Media,
  mediaSchema,
  REASON_WORDS,
  reasonOf,
  STATE_WORDS,
  stateOf,
  UNKNOWN_REASON,
  UNKNOWN_STATE,
} from "./media";
import { BulkBar, type Kept, KeptWords, type SelectionState, useSelection } from "./media-bulk";

const pageSchema = z.object({
  data: z.array(mediaSchema),
  meta: z.object({ next_cursor: z.uuid().nullable() }),
});
type Page = z.infer<typeof pageSchema>;

interface Filters {
  q: string;
  type: string;
  state: string;
  tag: string;
}
const NO_FILTERS: Filters = { q: "", type: "all", state: "all", tag: "" };
const NO_ROWS: Media[] = [];
const isFiltered = (filters: Filters) =>
  filters.q !== "" || filters.type !== "all" || filters.state !== "all" || filters.tag !== "";

function queryOf(filters: Filters, cursor?: string): string {
  const query = new URLSearchParams();
  if (filters.q !== "") query.set("q", filters.q);
  if (filters.type !== "all") query.set("type", filters.type);
  if (filters.state !== "all") query.set("state", filters.state);
  if (filters.tag !== "") query.set("tag", filters.tag);
  if (cursor !== undefined) query.set("cursor", cursor);
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

interface Ready {
  status: "ready";
  rows: Media[];
  next: string | null;
  more: "idle" | "busy" | "failed";
  updating: boolean;
  refreshFailed: ApiError | null;
}
type ListState = { status: "loading" } | { status: "failed"; error: ApiError } | Ready;

const firstPage = (page: Page): Ready => ({
  status: "ready",
  rows: page.data,
  next: page.meta.next_cursor,
  more: "idle",
  updating: false,
  refreshFailed: null,
});

// A failed read keeps the tiles already shown (with a notice); only a first read failing, or a refusal, replaces them.
function afterFailure(now: ListState, error: ApiError): ListState {
  if (now.status === "ready" && error.state !== "forbidden")
    return { ...now, updating: false, refreshFailed: error };
  return { status: "failed", error };
}

function appended(now: Ready, page: Page): Ready {
  const known = new Set(now.rows.map((one) => one.id));
  const fresh = page.data.filter((one) => !known.has(one.id));
  return { ...now, rows: [...now.rows, ...fresh], next: page.meta.next_cursor, more: "idle" };
}

// A new filter keeps the tiles on screen, marked as updating, until its first page arrives.
function useMediaList(ws: string, filters: Filters, attempt: number) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const moreBusy = useRef(false);
  const generation = useRef(0);
  const expired = useSignIn();
  const base = `/api/v1/workspaces/${ws}/media`;
  const read = (cursor?: string) =>
    request(pageSchema, `${base}${queryOf(filters, cursor)}`, { envelope: false });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` follows `filters`; `attempt` is the retry counter.
  useEffect(() => {
    let live = true;
    generation.current += 1;
    moreBusy.current = false;
    setState((now) => (now.status === "ready" ? { ...now, updating: true } : { status: "loading" }));
    read().then(
      (page) => live && setState(firstPage(page)),
      (error: unknown) => {
        const answer = asApiError(error);
        if (!live) return;
        if (answer.state === "session_expired") expired();
        else setState((now) => afterFailure(now, answer));
      },
    );
    return () => {
      live = false;
    };
  }, [base, filters, attempt]);

  const loadMore = () => {
    if (state.status !== "ready" || state.next === null || moreBusy.current) return;
    moreBusy.current = true;
    setState({ ...state, more: "busy" });
    // A page asked for under the old filters is dropped once the filters change.
    const asked = generation.current;
    const settled = (change: (now: Ready) => Ready) => {
      if (asked !== generation.current) return;
      moreBusy.current = false;
      setState((now) => (now.status === "ready" ? change(now) : now));
    };
    read(state.next).then(
      (page) => settled((now) => appended(now, page)),
      (error: unknown) => {
        const answer = asApiError(error);
        settled((now) => ({ ...now, more: "failed" }));
        if (answer.state === "session_expired") expired();
      },
    );
  };
  const update = (change: (rows: Media[]) => Media[]) =>
    setState((now) => (now.status === "ready" ? { ...now, rows: change(now.rows) } : now));
  return { state, loadMore, update };
}

function useWords() {
  const { t, i18n } = useLingui();
  return {
    state: (media: Media) => {
      const known = stateOf(media.state);
      return i18n._(known === "unknown" ? UNKNOWN_STATE : STATE_WORDS[known]);
    },
    reason: (media: Media) => {
      const known = reasonOf(media.reject_reason);
      return { known, words: i18n._(known === "unknown" ? UNKNOWN_REASON : REASON_WORDS[known]) };
    },
    all: t({ id: "media.filter.all", message: "All" }),
    image: t({ id: "media.filter.type.image", message: "Images" }),
    video: t({ id: "media.filter.type.video", message: "Videos" }),
  };
}
type Words = ReturnType<typeof useWords>;

export function KindIcon({ kind, testId }: { kind: "image" | "video"; testId: string }) {
  return (
    <span
      data-testid={testId}
      data-kind={kind}
      aria-hidden="true"
      className="flex size-full items-center justify-center"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-8 fill-none stroke-current stroke-2 text-text-muted"
      >
        {kind === "video" ? <path d="M8 5v14l11-7z" /> : <path d="M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4" />}
      </svg>
    </span>
  );
}

interface TileProps {
  media: Media;
  ws: string;
  words: Words;
  onTag: (tag: string) => void;
  selectable: boolean;
  kept: Kept | undefined;
}

function SelectBox() {
  return (
    <Checkbox
      slot="selection"
      data-testid="tile-select"
      className="group inline-flex size-6 pointer-coarse:size-11 shrink-0 items-center justify-center outline-none"
    >
      <span
        aria-hidden="true"
        className="flex size-5 items-center justify-center rounded-sm border-2 border-border-control bg-surface text-sm group-data-selected:bg-primary group-data-selected:text-on-primary group-data-focus-visible:outline-2 group-data-focus-visible:outline-offset-2 group-data-focus-visible:outline-focus"
      >
        <span className="hidden group-data-selected:inline">✓</span>
      </span>
    </Checkbox>
  );
}

function Tile({ media, ws, words, onTag, selectable, kept }: TileProps) {
  const { t } = useLingui();
  const reason = media.state === "rejected" ? words.reason(media) : null;
  return (
    <div className="flex gap-3 sm:flex-col">
      {selectable ? <SelectBox /> : null}
      <div className="size-16 shrink-0 overflow-hidden rounded-md bg-surface-sunken sm:aspect-square sm:size-auto">
        {hasThumb(media) ? (
          <img
            data-testid="tile-thumb"
            src={`/api/v1/workspaces/${ws}/media/${media.id}/derivatives/thumb`}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <KindIcon kind={kindOf(media.mime)} testId="tile-icon" />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span data-testid="tile-name" className="font-medium wrap-anywhere">
          <Link
            data-testid="tile-link"
            to={`/w/${ws}/media/${media.id}`}
            className="inline-block min-h-6 max-w-full pointer-coarse:leading-11 text-link underline"
          >
            <DirText>{media.file_name}</DirText>
          </Link>
        </span>
        <span data-testid="tile-state" data-state={stateOf(media.state)} className="text-sm">
          {words.state(media)}
        </span>
        {reason === null ? null : (
          <span data-testid="tile-reason" data-reason={reason.known} className="text-sm text-danger">
            {reason.words}
          </span>
        )}
        <KeptWords kept={kept} />
        <span className="flex flex-wrap gap-1">
          {media.tags.map((tag) => (
            <PlainButton
              key={tag}
              data-testid="tile-tag"
              aria-label={t({ id: "media.filter.by_tag", message: `Show only files tagged ${tag}` })}
              onPress={() => onTag(tag)}
              className="min-h-6 pointer-coarse:min-h-11 rounded-full border border-border px-2 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
            >
              <DirText>{tag}</DirText>
            </PlainButton>
          ))}
        </span>
      </div>
    </div>
  );
}

interface SearchProps {
  label: string;
  clearLabel: string;
  submitLabel: string;
  testId: string;
  onSearch: (text: string) => void;
}

function Search({ label, clearLabel, submitLabel, testId, onSearch }: SearchProps) {
  const [text, setText] = useState("");
  // Outside the field: a button inside it takes the field's clear-button behaviour and name.
  return (
    <div className="flex max-w-full items-end gap-1">
      <SearchField
        value={text}
        onChange={setText}
        onSubmit={(value) => onSearch(value.trim())}
        onClear={() => onSearch("")}
        className="flex min-w-0 flex-col gap-2"
      >
        <Label className="text-sm font-medium">{label}</Label>
        <div className="flex items-center gap-1 rounded-md border border-border-control bg-surface px-3">
          <Input
            data-testid={testId}
            className="min-h-10 pointer-coarse:min-h-11 w-full min-w-0 grow bg-transparent text-md outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          <PlainButton
            data-testid={`${testId}-clear`}
            aria-label={clearLabel}
            className="size-6 pointer-coarse:size-11 shrink-0 rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
          >
            ×
          </PlainButton>
        </div>
      </SearchField>
      <PlainButton
        data-testid={`${testId}-submit`}
        onPress={() => onSearch(text.trim())}
        className="min-h-10 pointer-coarse:min-h-11 rounded-md border border-border-control px-3 text-sm font-medium outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
      >
        {submitLabel}
      </PlainButton>
    </div>
  );
}

interface ToolbarProps {
  filters: Filters;
  words: Words;
  onChange: (filters: Filters) => void;
}

function Toolbar({ filters, words, onChange }: ToolbarProps) {
  const { t, i18n } = useLingui();
  const set = (change: Partial<Filters>) => onChange({ ...filters, ...change });
  const tag = filters.tag;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Search
        label={t({ id: "media.search.label", message: "Search by file name" })}
        clearLabel={t({ id: "media.search.clear", message: "Clear the search" })}
        submitLabel={t({ id: "media.search.submit", message: "Search" })}
        testId="media-search"
        onSearch={(q) => set({ q })}
      />
      <Search
        label={t({ id: "media.filter.tag", message: "Tag" })}
        clearLabel={t({ id: "media.filter.tag_clear", message: "Clear the tag" })}
        submitLabel={t({ id: "media.filter.tag_submit", message: "Filter by tag" })}
        testId="media-tag-filter"
        onSearch={(text) => set({ tag: text })}
      />
      <Select
        label={t({ id: "media.filter.type", message: "Type" })}
        testId="media-type"
        value={filters.type}
        onChange={(type) => set({ type })}
        options={[
          { value: "all", label: words.all },
          { value: "image", label: words.image },
          { value: "video", label: words.video },
        ]}
      />
      <Select
        label={t({ id: "media.filter.state", message: "State" })}
        testId="media-state-filter"
        value={filters.state}
        onChange={(state) => set({ state })}
        options={[
          { value: "all", label: words.all },
          ...LISTED_STATES.map((state) => ({ value: state, label: i18n._(STATE_WORDS[state]) })),
        ]}
      />
      {tag === "" ? null : (
        <Button data-testid="media-tag-active" onPress={() => set({ tag: "" })}>
          <Trans id="media.filter.tag_active">
            Remove the tag filter <DirText>{tag}</DirText>
          </Trans>
        </Button>
      )}
    </div>
  );
}

function ShowMore({ state, loadMore }: { state: Ready; loadMore: () => void }) {
  if (state.next === null) return null;
  return (
    <div className="flex flex-col items-start gap-3">
      {state.more === "failed" ? (
        <p data-testid="media-more-error" role="alert">
          <Trans id="media.more_failed">
            We could not load more media. The files above are still current. Try again.
          </Trans>
        </p>
      ) : null}
      <Button data-testid="media-more" busy={state.more === "busy"} onPress={loadMore}>
        <Trans id="media.more">Show more</Trans>
      </Button>
    </div>
  );
}

const GRID = "grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]";

interface LoadedProps {
  state: Ready;
  ws: string;
  words: Words;
  filters: Filters;
  onChange: (filters: Filters) => void;
  loadMore: () => void;
  retry: () => void;
  selection: SelectionState | null;
}

function RefreshFailed({ error, retry }: { error: ApiError; retry: () => void }) {
  return (
    <div data-testid="media-refresh-error" role="alert" className="flex flex-col items-start gap-3">
      <ErrorPanel
        what={<Trans id="media.refresh_failed.what">We could not apply these filters</Trans>}
        meaning={<Trans id="media.refresh_failed.meaning">The files below are from before. Try again.</Trans>}
        error={error}
      />
      <Button data-testid="media-refresh-retry" onPress={retry}>
        <Trans id="media.retry">Try again</Trans>
      </Button>
    </div>
  );
}

function Loaded({ state, ws, words, filters, onChange, loadMore, retry, selection }: LoadedProps) {
  const { t } = useLingui();
  const notice = state.refreshFailed ? <RefreshFailed error={state.refreshFailed} retry={retry} /> : null;
  if (state.rows.length === 0)
    return (
      <>
        {notice}
        <Empty filtered={isFiltered(filters)} onClear={() => onChange(NO_FILTERS)} />
      </>
    );
  return (
    <>
      {notice}
      {state.updating ? (
        <p data-testid="media-updating" role="status">
          <Trans id="media.updating">Updating</Trans>
        </p>
      ) : null}
      <GridList
        aria-label={t({ id: "media.list_label", message: "Media files" })}
        items={state.rows}
        layout="grid"
        className={GRID}
        // The tiles are cached per row; a file's refusal reason lives outside the row, so it re-renders them.
        dependencies={[selection?.kept]}
        {...(selection
          ? {
              selectionMode: "multiple",
              selectedKeys: selection.selected,
              onSelectionChange: selection.choose,
            }
          : {})}
      >
        {(media) => (
          <GridListItem
            id={media.id}
            textValue={media.file_name}
            data-testid="media-tile"
            data-media-id={media.id}
            className="rounded-md border border-border p-3 outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus data-selected:border-primary"
          >
            <Tile
              media={media}
              ws={ws}
              words={words}
              onTag={(tag) => onChange({ ...filters, tag })}
              selectable={selection !== null}
              kept={selection?.kept.get(media.id)}
            />
          </GridListItem>
        )}
      </GridList>
      <ShowMore state={state} loadMore={loadMore} />
    </>
  );
}

function Empty({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  if (filtered) {
    return (
      <EmptyState
        kind="filtered-out"
        title={<Trans id="media.empty.filtered">No media matches these filters</Trans>}
        onClearFilters={onClear}
      />
    );
  }
  return (
    <EmptyState kind="first-use" title={<Trans id="media.empty.title">No media yet</Trans>}>
      <Trans id="media.empty.meaning">Images and videos you add to posts will appear here.</Trans>
    </EmptyState>
  );
}

const SKELETON_DELAY_MS = 300;
const SKELETON_TILES = ["a", "b", "c", "d", "e", "f"];

// The placeholder shows only when a read is slow, so a fast read never flashes it.
export function Late({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      {late ? children : null}
    </div>
  );
}

function Loading() {
  return (
    <Late label={<Trans id="media.loading">Loading your media</Trans>}>
      <div data-testid="media-skeleton" className={GRID}>
        {SKELETON_TILES.map((key) => (
          <div key={key} className="h-20 rounded-md bg-surface-sunken sm:aspect-square sm:h-auto" />
        ))}
      </div>
    </Late>
  );
}

function Failed({ error, retry }: { error: ApiError; retry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <ErrorPanel
        what={<Trans id="media.failed.what">We could not load your media</Trans>}
        meaning={<Trans id="media.failed.meaning">Nothing was changed. Try again.</Trans>}
        error={error}
      />
      <Button data-testid="media-retry" onPress={retry}>
        <Trans id="media.retry">Try again</Trans>
      </Button>
    </div>
  );
}

const stateName = (state: ListState, filters: Filters) => {
  if (state.status !== "ready") return state.status;
  if (state.rows.length > 0) return "list";
  return isFiltered(filters) ? "filtered" : "empty";
};

// Keyed by the workspace (see the page), so nothing of the old workspace can reach the new one.
function MediaLibrary({ ws }: { ws: string }) {
  const [filters, setFilters] = useState(NO_FILTERS);
  const [attempt, setAttempt] = useState(0);
  const { state, loadMore, update } = useMediaList(ws, filters, attempt);
  const words = useWords();
  const rows = state.status === "ready" ? state.rows : NO_ROWS;
  const selection = useSelection(rows);
  const heading = useRef<HTMLHeadingElement>(null);
  // Editing is allowed for the whole role, so the first row tells whether this caller may select.
  const selectable = rows[0]?.actions.includes("edit") === true;
  if (state.status === "failed" && state.error.state === "forbidden") return <ForbiddenPage />;
  return (
    <div data-testid="media-state" data-state={stateName(state, filters)} className="flex flex-col gap-5">
      <h1
        ref={heading}
        tabIndex={-1}
        data-testid="media-heading"
        className="font-heading text-2xl outline-none"
      >
        <Trans id="media.title">Media</Trans>
      </h1>
      <Toolbar filters={filters} words={words} onChange={setFilters} />
      {selectable ? (
        <BulkBar
          rows={rows}
          base={`/api/v1/workspaces/${ws}/media`}
          selection={selection}
          update={update}
          heading={heading}
        />
      ) : null}
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "failed" ? (
        <Failed error={state.error} retry={() => setAttempt((now) => now + 1)} />
      ) : null}
      {state.status === "ready" ? (
        <Loaded
          state={state}
          ws={ws}
          words={words}
          filters={filters}
          onChange={setFilters}
          loadMore={loadMore}
          retry={() => setAttempt((now) => now + 1)}
          selection={selectable ? selection : null}
        />
      ) : null}
    </div>
  );
}

export function MediaLibraryPage() {
  const { ws = "" } = useParams();
  const shell = useShellData();
  if (isUnknownWorkspace(shell, ws)) return <NotFoundPage />;
  return <MediaLibrary key={ws} ws={ws} />;
}
