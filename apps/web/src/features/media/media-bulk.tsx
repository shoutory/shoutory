import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { Selection } from "react-aria-components";
import { z } from "zod";
import { type ApiError, request } from "../../http/client";
import { formatNumber } from "../../i18n/i18n";
import { useOnline } from "../../shell/offline-banner";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { useFormatPrefs } from "../../ui/localized";
import { TextField } from "../../ui/text-field";
import { toasts } from "../../ui/toast";
import { useSignIn } from "../channels/channels-hub";
import {
  asApiError,
  CONTROL,
  DELETE_WHAT,
  deleteRefusal,
  detailSchema,
  type Media,
  NOT_READY,
  SAVE_WHAT,
  saveRefusal,
  TAG_INVALID,
  TAG_MAX,
  TAGS_FULL,
  TAGS_MAX,
} from "./media";

// One request per file, one after another; a larger set is refused with a word rather than sent.
const BULK_MAX = 100;
const NETWORK: Kept = {
  code: "network",
  words: msg({
    id: "media.bulk.network",
    message: "Not sent: the connection dropped. Try again when online.",
  }),
};

export interface Kept {
  code: string;
  words: MessageDescriptor;
}
type Rows = (rows: Media[]) => Media[];
type Outcome =
  | { kind: "applied"; change?: Rows }
  | { kind: "gone" }
  | { kind: "kept"; kept: Kept }
  | { kind: "network" }
  | { kind: "session" };
type Step = (media: Media) => Promise<Outcome>;

export function useSelection(rows: Media[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [kept, setKept] = useState<ReadonlyMap<string, Kept>>(new Map());
  const [tooMany, setTooMany] = useState(false);
  // A file that left the list (a new filter, a delete, a read again) leaves the selection too.
  useEffect(() => {
    const listed = new Set(rows.map((one) => one.id));
    setSelected((now) => {
      const next = [...now].filter((id) => listed.has(id));
      return next.length === now.size ? now : new Set(next);
    });
    setKept((now) => {
      const next = [...now].filter(([id]) => listed.has(id));
      return next.length === now.size ? now : new Map(next);
    });
    setTooMany(false);
  }, [rows]);
  const choose = (keys: Selection) => {
    const next = keys === "all" ? rows.map((one) => one.id) : [...keys].map(String);
    setTooMany(next.length > BULK_MAX);
    if (next.length > BULK_MAX) return;
    setSelected(new Set(next));
    setKept((now) => new Map([...now].filter(([id]) => next.includes(id))));
  };
  const after = (stayed: ReadonlyMap<string, Kept | undefined>) => {
    setSelected(new Set(stayed.keys()));
    setKept(new Map([...stayed].filter((entry): entry is [string, Kept] => entry[1] !== undefined)));
  };
  return { selected, kept, tooMany, choose, after };
}
export type SelectionState = ReturnType<typeof useSelection>;

function failed(error: ApiError, words: (error: ApiError) => Kept): Outcome {
  if (error.state === "session_expired") return { kind: "session" };
  if (error.code === "network") return { kind: "network" };
  if (error.status === 404) return { kind: "gone" };
  return { kind: "kept", kept: words(error) };
}

const without =
  (id: string): Rows =>
  (rows) =>
    rows.filter((one) => one.id !== id);

function deleteStep(base: string): Step {
  return async (media) => {
    if (!media.actions.includes("delete"))
      return { kind: "kept", kept: { code: "not_ready", words: NOT_READY } };
    try {
      await request(z.undefined(), `${base}/${media.id}`, { method: "DELETE", envelope: false });
      return { kind: "applied", change: without(media.id) };
    } catch (error) {
      return failed(asApiError(error), (refused) => {
        const code = deleteRefusal(refused);
        return { code, words: DELETE_WHAT[code] };
      });
    }
  };
}

// The whole list is sent with the tag added, so a change made elsewhere since the list was read is overwritten.
function tagStep(base: string, tag: string): Step {
  return async (media) => {
    if (media.tags.includes(tag)) return { kind: "applied" };
    if (media.tags.length >= TAGS_MAX) return { kind: "kept", kept: { code: "tags_full", words: TAGS_FULL } };
    try {
      const fresh = await request(detailSchema, `${base}/${media.id}`, {
        method: "PATCH",
        body: { tags: [...media.tags, tag] },
      });
      return { kind: "applied", change: (rows) => rows.map((one) => (one.id === media.id ? fresh : one)) };
    } catch (error) {
      return failed(asApiError(error), (refused) => {
        const code = saveRefusal(refused);
        return { code, words: SAVE_WHAT[code] };
      });
    }
  };
}

interface Progress {
  done: number;
  total: number;
  stopping: boolean;
}

interface RunEnd {
  applied: number;
  stayed: Map<string, Kept | undefined>;
}

// Records one answer; answers true when the run must end here because the connection dropped.
function record(
  end: RunEnd,
  media: Media,
  outcome: Exclude<Outcome, { kind: "session" }>,
  update: (change: Rows) => void,
): boolean {
  if (outcome.kind === "network") {
    end.stayed.set(media.id, NETWORK);
    return true;
  }
  if (outcome.kind === "kept") {
    end.stayed.set(media.id, outcome.kept);
    return false;
  }
  if (outcome.kind === "applied") end.applied += 1;
  const change = outcome.kind === "gone" ? without(media.id) : outcome.change;
  if (change) update(change);
  return false;
}

function useRun(update: (change: Rows) => void) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const stop = useRef(false);
  const mounted = useRef(true);
  const expired = useSignIn();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The page was left, or the session ended and sign-in takes over.
  const ended = (outcome: Outcome): outcome is Extract<Outcome, { kind: "session" }> => {
    if (outcome.kind === "session" && mounted.current) {
      setProgress(null);
      expired();
    }
    return !mounted.current || outcome.kind === "session";
  };
  // Each answer is applied as it comes, so nothing leaves the screen before the server confirmed it.
  const start = async (items: Media[], step: Step): Promise<RunEnd | null> => {
    stop.current = false;
    setProgress({ done: 0, total: items.length, stopping: false });
    const end: RunEnd = { applied: 0, stayed: new Map() };
    let sent = 0;
    // The files not sent stay selected: with the network reason after a dropped connection, with none after Stop.
    let halt: Kept | undefined;
    for (const media of items) {
      if (stop.current) break;
      sent += 1;
      const outcome = await step(media);
      if (ended(outcome)) return null;
      if (record(end, media, outcome, update)) {
        halt = NETWORK;
        break;
      }
      setProgress((now) => now && { ...now, done: sent });
    }
    for (const media of items.slice(sent)) end.stayed.set(media.id, halt);
    setProgress(null);
    return end;
  };
  const requestStop = () => {
    stop.current = true;
    setProgress((now) => now && { ...now, stopping: true });
  };
  return { progress, start, requestStop };
}

function useCounts() {
  const prefs = useFormatPrefs();
  const { t } = useLingui();
  return {
    selected: (count: number) => {
      const shown = formatNumber(count, prefs);
      return t({
        id: "media.bulk.selected",
        message: plural(count, { one: `${shown} file selected`, other: `${shown} files selected` }),
      });
    },
    deleted: (count: number) => {
      const shown = formatNumber(count, prefs);
      return t({
        id: "media.bulk.deleted",
        message: plural(count, { one: `${shown} file deleted`, other: `${shown} files deleted` }),
      });
    },
    tagged: (count: number) => {
      const shown = formatNumber(count, prefs);
      return t({
        id: "media.bulk.tagged",
        message: plural(count, { one: `Tag added to ${shown} file`, other: `Tag added to ${shown} files` }),
      });
    },
    kept: (count: number) => {
      const shown = formatNumber(count, prefs);
      return t({
        id: "media.bulk.kept",
        message: plural(count, {
          one: `${shown} file was not changed. It stays selected and says why.`,
          other: `${shown} files were not changed. They stay selected and say why.`,
        }),
      });
    },
    progress: (progress: Progress) => {
      const done = formatNumber(progress.done, prefs);
      const total = formatNumber(progress.total, prefs);
      return t({ id: "media.bulk.progress", message: `Done ${done} of ${total}` });
    },
  };
}

function RunProgress({ progress, onStop }: { progress: Progress; onStop: () => void }) {
  const counts = useCounts();
  const { t } = useLingui();
  return (
    <div data-testid="bulk-progress" className="flex flex-col items-start gap-3">
      <p role="status">{counts.progress(progress)}</p>
      <Button
        autoFocus
        data-testid="bulk-stop"
        {...(progress.stopping
          ? {
              "aria-disabled": true,
              reason: t({ id: "media.bulk.stopping", message: "Stopping after the current file." }),
            }
          : {})}
        onPress={onStop}
      >
        <Trans id="media.bulk.stop">Stop</Trans>
      </Button>
    </div>
  );
}

function TagForm({ cancel, confirm }: { cancel: () => void; confirm: (tag: string) => void }) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();
  const submit = () => {
    const tag = draft.trim();
    if (tag === "" || tag.length > TAG_MAX || CONTROL.test(tag)) setProblem(t(TAG_INVALID));
    else confirm(tag);
  };
  return (
    <div data-testid="bulk-tag-dialog" className="flex flex-col gap-5">
      <TextField
        label={t({ id: "media.bulk.tag_label", message: "Tag to add" })}
        testId="bulk-tag"
        value={draft}
        onChange={setDraft}
        {...(problem === undefined ? {} : { errorMessage: problem })}
      />
      <div className="flex flex-wrap gap-3">
        <Button data-testid="bulk-tag-confirm" onPress={submit}>
          <Trans id="media.bulk.tag_confirm">Add tag</Trans>
        </Button>
        <Button data-testid="bulk-tag-cancel" onPress={cancel}>
          <Trans id="media.cancel">Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}

function DeleteForm({ count, cancel, confirm }: { count: number; cancel: () => void; confirm: () => void }) {
  const prefs = useFormatPrefs();
  const shown = formatNumber(count, prefs);
  const { t } = useLingui();
  return (
    <div data-testid="bulk-delete-dialog" className="flex flex-col gap-5">
      <p data-testid="bulk-delete-impact">
        {t({
          id: "media.bulk.delete_impact",
          message: plural(count, {
            one: `${shown} file leaves the library and is deleted. This cannot be undone.`,
            other: `${shown} files leave the library and are deleted. This cannot be undone.`,
          }),
        })}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button autoFocus data-testid="bulk-delete-cancel" onPress={cancel}>
          <Trans id="media.cancel">Cancel</Trans>
        </Button>
        <Button data-testid="bulk-delete-confirm" onPress={confirm}>
          <Trans id="media.delete.confirm">Delete</Trans>
        </Button>
      </div>
    </div>
  );
}

type Open = "tag" | "delete" | null;

function useFocusAfter(heading: RefObject<HTMLElement | null>) {
  const tag = useRef<HTMLButtonElement>(null);
  const remove = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const refs = { tag, delete: remove, result, heading };
  // A frame later: after the dialog's own focus restore, and the heading still exists when the bar is gone.
  const setTarget = (target: keyof typeof refs) => requestAnimationFrame(() => refs[target].current?.focus());
  return { setTarget, tag, remove, result };
}

function BarNotes({
  selection,
  result,
}: {
  selection: SelectionState;
  result: RefObject<HTMLParagraphElement | null>;
}) {
  const counts = useCounts();
  const count = selection.selected.size;
  return (
    <>
      <p data-testid="media-bulk-count" role="status" className="text-sm">
        {count > 0 ? (
          counts.selected(count)
        ) : (
          <Trans id="media.bulk.hint">Select files to tag or delete several at once.</Trans>
        )}
      </p>
      {selection.tooMany ? (
        <p data-testid="media-bulk-too-many" role="alert" className="text-sm text-danger">
          <Trans id="media.bulk.too_many">You can select at most 100 files at once.</Trans>
        </p>
      ) : null}
      {selection.kept.size > 0 ? (
        <p ref={result} tabIndex={-1} data-testid="media-bulk-result" className="text-sm outline-none">
          {counts.kept(selection.kept.size)}
        </p>
      ) : null}
    </>
  );
}

interface BarProps {
  rows: Media[];
  base: string;
  selection: SelectionState;
  update: (change: Rows) => void;
  heading: RefObject<HTMLElement | null>;
}

interface ButtonsProps {
  focus: ReturnType<typeof useFocusAfter>;
  open: (which: Open) => void;
  clear: () => void;
}

function BarButtons({ focus, open, clear }: ButtonsProps) {
  const { t } = useLingui();
  const offline = useOnline()
    ? {}
    : { "aria-disabled": true, reason: t({ id: "media.bulk.offline", message: "You are offline." }) };
  return (
    <>
      <Button ref={focus.tag} data-testid="media-bulk-tag" {...offline} onPress={() => open("tag")}>
        <Trans id="media.bulk.tag">Add a tag</Trans>
      </Button>
      <Button ref={focus.remove} data-testid="media-bulk-delete" {...offline} onPress={() => open("delete")}>
        <Trans id="media.bulk.delete">Delete</Trans>
      </Button>
      <Button data-testid="media-bulk-clear" onPress={clear}>
        <Trans id="media.bulk.clear">Clear selection</Trans>
      </Button>
    </>
  );
}

// A run that keeps some files ends on the result line, which is read when it takes focus, so only success gets a toast.
function useBulkRun({ rows, selection, update, heading }: Omit<BarProps, "base">) {
  const [open, setOpen] = useState<Open>(null);
  const run = useRun(update);
  const focus = useFocusAfter(heading);
  const close = (which: "tag" | "delete") => {
    setOpen(null);
    focus.setTarget(which);
  };
  const go = async (step: Step, done: (applied: number) => string) => {
    const end = await run.start(
      rows.filter((one) => selection.selected.has(one.id)),
      step,
    );
    if (end === null) return;
    setOpen(null);
    selection.after(end.stayed);
    if (end.stayed.size > 0) return focus.setTarget("result");
    toasts.show({ kind: "success", title: done(end.applied) });
    focus.setTarget("heading");
  };
  return { open, setOpen, run, focus, close, go };
}

export function BulkBar(props: BarProps) {
  const { base, selection } = props;
  const counts = useCounts();
  const { open, setOpen, run, focus, close, go } = useBulkRun(props);
  const count = selection.selected.size;
  const dialog = (which: "tag" | "delete", title: ReactNode, running: ReactNode, form: ReactNode) => (
    <Dialog
      title={run.progress ? running : title}
      isOpen={open === which}
      locked={run.progress !== null}
      onOpenChange={(next) => (next ? setOpen(which) : close(which))}
    >
      {run.progress ? <RunProgress progress={run.progress} onStop={run.requestStop} /> : form}
    </Dialog>
  );
  return (
    <div data-testid="media-bulk-bar" className="flex min-h-12 flex-wrap items-center gap-3">
      <BarNotes selection={selection} result={focus.result} />
      {count > 0 ? (
        <BarButtons focus={focus} open={setOpen} clear={() => selection.choose(new Set())} />
      ) : null}
      {dialog(
        "tag",
        <Trans id="media.bulk.tag_title">Add a tag to the selected files</Trans>,
        <Trans id="media.bulk.tag_running">Adding the tag…</Trans>,
        <TagForm cancel={() => close("tag")} confirm={(tag) => go(tagStep(base, tag), counts.tagged)} />,
      )}
      {dialog(
        "delete",
        <Trans id="media.bulk.delete_title">Delete the selected files?</Trans>,
        <Trans id="media.bulk.delete_running">Deleting the files…</Trans>,
        <DeleteForm
          count={count}
          cancel={() => close("delete")}
          confirm={() => go(deleteStep(base), counts.deleted)}
        />,
      )}
    </div>
  );
}

export function KeptWords({ kept }: { kept: Kept | undefined }) {
  const { i18n } = useLingui();
  if (kept === undefined) return null;
  return (
    <span data-testid="tile-bulk-error" data-reason={kept.code} className="text-sm text-danger">
      {i18n._(kept.words)}
    </span>
  );
}
