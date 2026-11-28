import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, request } from "../../http/client";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { DirText } from "../../ui/dir-text";
import { ErrorPanel } from "../../ui/error-panel";
import { type Media, mediaSchema } from "../media/media";
import { useStateWord } from "./media-state";

const pageSchema = z.object({
  data: z.array(mediaSchema),
  meta: z.object({ next_cursor: z.string().nullable() }),
});

type Listed =
  | { status: "loading" }
  | { status: "failed"; error: ApiError }
  | { status: "ready"; rows: Media[]; next: string | null };

/** The workspace's files, to pick from; a file still being checked or processed is listed but cannot be added yet. */
export function LibraryDialog({
  workspace,
  chosen,
  onAdd,
  onClose,
}: {
  workspace: string;
  chosen: readonly string[];
  onAdd: (row: Media) => void;
  onClose: () => void;
}) {
  const stateWord = useStateWord();
  const [listed, setListed] = useState<Listed>({ status: "loading" });
  const base = `/api/v1/workspaces/${workspace}/media?limit=50`;
  const read = (cursor?: string) =>
    request(pageSchema, cursor ? `${base}&cursor=${cursor}` : base, { envelope: false });
  const failed = (error: unknown) => {
    if (!(error instanceof ApiError)) throw error;
    setListed({ status: "failed", error });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first page is read once, when the dialog opens
  useEffect(() => {
    read().then(
      (page) => setListed({ status: "ready", rows: page.data, next: page.meta.next_cursor }),
      failed,
    );
  }, []);
  const more = (now: Listed & { status: "ready" }) =>
    read(now.next ?? undefined).then(
      (page) =>
        setListed({ status: "ready", rows: [...now.rows, ...page.data], next: page.meta.next_cursor }),
      failed,
    );
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={<Trans id="composer.library.title">Choose from your files</Trans>}
    >
      <div data-testid="library-dialog" className="flex flex-col gap-3">
        {listed.status === "loading" ? (
          <p role="status">
            <Trans id="system.loading">Loading</Trans>
          </p>
        ) : null}
        {listed.status === "failed" ? (
          <ErrorPanel
            error={listed.error}
            what={<Trans id="composer.library.failed.what">We could not load your files</Trans>}
            meaning={<Trans id="composer.library.failed.meaning">Nothing was changed.</Trans>}
          />
        ) : null}
        {listed.status === "ready" && listed.rows.length === 0 ? (
          <p>
            <Trans id="composer.library.empty">There are no files yet. Upload one first.</Trans>
          </p>
        ) : null}
        {listed.status === "ready" ? (
          <ul className="flex max-h-80 flex-col gap-2 overflow-auto">
            {listed.rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3">
                <span className="flex min-w-0 flex-col">
                  <DirText>{row.file_name}</DirText>
                  <span className="text-sm text-text-muted">{stateWord(row.state)}</span>
                </span>
                <Button
                  data-testid="library-add"
                  aria-disabled={row.state !== "ready" || chosen.includes(row.id)}
                  onPress={() => onAdd(row)}
                >
                  <Trans id="composer.library.add">Add</Trans>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {listed.status === "ready" && listed.next !== null ? (
          <Button onPress={() => void more(listed)}>
            <Trans id="composer.library.more">Show more</Trans>
          </Button>
        ) : null}
        <Button onPress={onClose}>
          <Trans id="composer.library.close">Close</Trans>
        </Button>
      </div>
    </Dialog>
  );
}
