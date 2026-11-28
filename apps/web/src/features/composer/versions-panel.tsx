import { Trans, useLingui } from "@lingui/react/macro";
import { draftSchema } from "@shoutory/core/content";
import { useEffect, useRef, useState } from "react";
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { z } from "zod";
import { readZone } from "../../account/prefs";
import { ApiError, request } from "../../http/client";
import { Button } from "../../ui/button";
import { ErrorPanel } from "../../ui/error-panel";
import { LocalizedDateTime } from "../../ui/localized";
import { type Doc, fromDraft } from "./composer-data";
import { DraftView } from "./conflict-dialog";

const rowSchema = z.object({
  id: z.string(),
  version_no: z.number(),
  kind: z.string(),
  created_at: z.string(),
});
type Row = z.infer<typeof rowSchema>;
const pageSchema = z.object({
  data: z.array(rowSchema),
  meta: z.object({ next_cursor: z.string().nullable() }),
});
const oneSchema = z.object({ draft: draftSchema });
const restoredSchema = z.object({ version_id: z.string(), pending_changes: z.array(z.string()) });

const PAGE = 20;

function useKindWords(): (kind: string) => string {
  const { t } = useLingui();
  const words: Record<string, string> = {
    autosave: t({ id: "composer.versions.kind.autosave", message: "Autosave" }),
    save: t({ id: "composer.versions.kind.save", message: "Saved" }),
    submitted: t({ id: "composer.versions.kind.submitted", message: "Submitted" }),
    scheduled: t({ id: "composer.versions.kind.scheduled", message: "Scheduled" }),
    published: t({ id: "composer.versions.kind.posted", message: "Posted" }),
  };
  return (kind) => words[kind] ?? t({ id: "composer.versions.kind.other", message: "Version" });
}

interface Props {
  workspace: string;
  postId: string;
  nameOf: (channelId: string) => string;
  /** Saves what is on screen first; false when it could not be saved. */
  beforeRestore: () => Promise<boolean>;
  currentVersion: () => string | null;
  onRestored: (doc: Doc, version: string, pending: string[]) => void;
}

// The versions, newest first, a page at a time.
function useVersions(base: string) {
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const read = (cursor?: string) => {
    setLoading(true);
    request(pageSchema, `${base}/versions?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
      envelope: false,
    }).then(
      (page) => {
        setRows((now) => [...now, ...page.data]);
        setNext(page.meta.next_cursor);
        setLoading(false);
      },
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
        setFailure(error);
        setLoading(false);
      },
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first page is read once, when the panel opens
  useEffect(() => read(), []);
  return { rows, next, failure, loading, more: () => next && read(next) };
}

function Rows(
  props: Props & { rows: Row[]; onView: (row: Row) => void; onRestore: (row: Row) => void; busy: boolean },
) {
  const kindWord = useKindWords();
  return (
    <ul className="flex flex-col gap-3">
      {props.rows.map((row) => (
        <li
          key={row.id}
          data-testid="version-row"
          className="flex flex-col gap-2 rounded-md border border-border p-3"
        >
          <span className="font-medium">
            <Trans id="composer.versions.row">
              Version {row.version_no}, {kindWord(row.kind)}
            </Trans>
          </span>
          <span className="text-sm text-text-muted">
            <LocalizedDateTime value={new Date(row.created_at)} timeZone={readZone()} />
          </span>
          <div className="flex flex-wrap gap-2">
            <Button data-testid="version-preview" onPress={() => props.onView(row)}>
              <Trans id="composer.versions.preview">Preview</Trans>
            </Button>
            <Button
              data-testid="version-restore"
              busy={props.busy}
              aria-disabled={props.busy}
              onPress={() => props.onRestore(row)}
            >
              <Trans id="composer.versions.restore">Restore as new version</Trans>
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// Reading one version and bringing one back; one of them at a time.
function useSheetActions(props: Props, base: string, onClose: () => void) {
  const [viewing, setViewing] = useState<Doc | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const draftOf = async (row: Row) =>
    fromDraft((await request(oneSchema, `${base}/versions/${row.id}`)).draft);
  const guarded = async (act: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await act();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setFailure(error);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const restore = (row: Row) =>
    guarded(async () => {
      if (!(await props.beforeRestore())) return;
      const doc = await draftOf(row);
      const done = await request(restoredSchema, `${base}/versions/${row.id}/restore`, {
        method: "POST",
        headers: { "If-Match": `"${props.currentVersion()}"` },
      });
      props.onRestored(doc, done.version_id, done.pending_changes);
      onClose();
    });
  return {
    viewing,
    failure,
    busy,
    view: (row: Row) => void guarded(async () => setViewing(await draftOf(row))),
    restore: (row: Row) => void restore(row),
  };
}

function Sheet({ props, onClose }: { props: Props; onClose: () => void }) {
  const base = `/api/v1/workspaces/${props.workspace}/posts/${props.postId}`;
  const list = useVersions(base);
  const { viewing, failure, busy, view, restore } = useSheetActions(props, base, onClose);
  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      className="fixed inset-0 z-40 flex justify-end bg-text/40"
    >
      <Modal className="h-full w-full max-w-md overflow-auto bg-surface p-6 shadow-lg outline-none md:rounded-s-lg">
        <AriaDialog className="flex flex-col gap-4 outline-none">
          <Heading slot="title" className="font-heading text-xl">
            <Trans id="composer.versions.title">Version history</Trans>
          </Heading>
          {list.failure ? <ListFailure error={list.failure} /> : null}
          {failure ? (
            <div data-testid="version-failure">
              <ErrorPanel
                error={failure}
                what={<Trans id="composer.versions.failed.what">We could not restore this version</Trans>}
                meaning={<Trans id="composer.versions.failed.meaning">Nothing was changed.</Trans>}
              />
            </div>
          ) : null}
          <Rows {...props} rows={list.rows} busy={busy} onView={view} onRestore={restore} />
          {list.next ? (
            <Button data-testid="versions-more" onPress={() => list.more()}>
              <Trans id="composer.versions.more">Show older versions</Trans>
            </Button>
          ) : null}
          {viewing ? (
            <DraftView
              testId="version-view"
              title={<Trans id="composer.versions.view">This version</Trans>}
              doc={viewing}
              nameOf={props.nameOf}
            />
          ) : null}
          <Button onPress={onClose}>
            <Trans id="composer.versions.close">Close</Trans>
          </Button>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

function ListFailure({ error }: { error: ApiError }) {
  return (
    <ErrorPanel
      error={error}
      what={<Trans id="composer.versions.list_failed.what">We could not load the versions</Trans>}
      meaning={<Trans id="composer.versions.list_failed.meaning">Nothing was changed.</Trans>}
    />
  );
}

/** The saves of a post, to read and to bring back as a new version. */
export function VersionsPanel(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-testid="versions-open" onPress={() => setOpen(true)}>
        <Trans id="composer.versions.open">Version history</Trans>
      </Button>
      {open ? <Sheet props={props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
