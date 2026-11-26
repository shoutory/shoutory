import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Link, useRevalidator } from "react-router";
import { type ZodType, z } from "zod";
import { useLoad } from "../account/use-load";
import { authCopy } from "../auth/auth-copy";
import { useAction } from "../auth/auth-frame";
import { type ApiError, request } from "../http/client";
import type { Workspace } from "../shell/shell-data";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { EmptyState } from "../ui/empty-state";
import { ErrorPanel } from "../ui/error-panel";
import { useChange } from "./member-actions";

const image = z.object({ id: z.string(), file_name: z.string() });
type Image = z.infer<typeof image>;
const imagePage = z.object({ data: z.array(image), meta: z.object({ next_cursor: z.string().nullable() }) });
const saved = z.object({ id: z.string() });

const thumbOf = (ws: string, id: string) => `/api/v1/workspaces/${ws}/media/${id}/derivatives/thumb`;
const bare = <T,>(schema: ZodType<T>, path: string) => request(schema, path, { envelope: false });
const initialOf = (name: string) => [...name.trim()][0]?.toLocaleUpperCase() ?? "";

/** The workspace picture, or its first letter when it has none or the picture cannot be shown. */
export function WorkspaceAvatar({ workspace }: { workspace: Pick<Workspace, "id" | "name" | "avatar"> }) {
  const [broken, setBroken] = useState<string | null>(null);
  const { avatar } = workspace;
  return (
    <span
      aria-hidden="true"
      data-testid="workspace-avatar"
      className="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-sunken text-sm font-medium"
    >
      {avatar && broken !== avatar ? (
        <img
          src={thumbOf(workspace.id, avatar)}
          alt=""
          width={32}
          height={32}
          className="size-full object-cover"
          onError={() => setBroken(avatar)}
        />
      ) : (
        initialOf(workspace.name)
      )}
    </span>
  );
}

function avatarCopy(error: ApiError) {
  if (error.details?.reason !== "media_unavailable") return authCopy("link", error);
  return {
    what: <Trans id="avatar.unavailable.what">That image can no longer be used</Trans>,
    meaning: (
      <Trans id="avatar.unavailable.meaning">
        It was deleted or is not ready. Choose another. Nothing was changed.
      </Trans>
    ),
  };
}

function useAvatarSave(ws: string, onDone: () => void) {
  const revalidator = useRevalidator();
  const chosen = useRef<string | null>(null);
  const change = useChange(async () => {
    await request(saved, `/api/v1/workspaces/${ws}`, { method: "PATCH", body: { avatar: chosen.current } });
    await revalidator.revalidate();
    onDone();
  });
  const pick = (id: string | null) => {
    chosen.current = id;
    void change.run();
  };
  return { ...change, pick };
}

// Ready images only: a picture still being processed has no thumbnail to show.
function useImages(ws: string) {
  const first = useLoad(imagePage, `/api/v1/workspaces/${ws}/media?type=image&state=ready`, 0, bare);
  const [extra, setExtra] = useState<{ rows: Image[]; next: string | null } | null>(null);
  const next = extra ? extra.next : first.state.status === "done" ? first.state.data.meta.next_cursor : null;
  const more = useAction(async () => {
    if (next === null) return;
    const page = await bare(
      imagePage,
      `/api/v1/workspaces/${ws}/media?type=image&state=ready&cursor=${encodeURIComponent(next)}`,
    );
    setExtra((now) => ({ rows: [...(now?.rows ?? []), ...page.data], next: page.meta.next_cursor }));
  });
  const rows = first.state.status === "done" ? [...first.state.data.data, ...(extra?.rows ?? [])] : [];
  return { first, rows, next, more };
}

type GridProps = { ws: string; onPick: (id: string) => void; busy: boolean };

// A tile stays focusable while a save runs: the native disabled state would drop the keyboard focus.
function Tiles({ ws, rows, onPick, busy }: GridProps & { rows: Image[] }) {
  const { t } = useLingui();
  return (
    <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
      {rows.map((row) => (
        <li key={row.id}>
          <AriaButton
            data-testid="avatar-choice"
            aria-disabled={busy}
            onPress={() => {
              if (!busy) onPick(row.id);
            }}
            aria-label={t({ id: "avatar.use", message: `Use ${row.file_name}` })}
            className="block aspect-square w-full overflow-hidden rounded-md bg-surface-sunken outline-offset-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus aria-disabled:opacity-60"
          >
            <img src={thumbOf(ws, row.id)} alt="" loading="lazy" className="size-full object-cover" />
          </AriaButton>
        </li>
      ))}
    </ul>
  );
}

function ImageGrid({ ws, onPick, busy }: GridProps) {
  const { first, rows, next, more } = useImages(ws);
  if (first.state.status === "loading")
    return (
      <p role="status">
        <Trans id="system.loading">Loading</Trans>
      </p>
    );
  if (first.state.status === "failed")
    return (
      <ErrorPanel error={first.state.error} onRetry={first.reload} {...authCopy("link", first.state.error)} />
    );
  if (rows.length === 0)
    return (
      <EmptyState kind="first-use" title={<Trans id="avatar.empty.title">No images yet</Trans>}>
        <Trans id="avatar.empty.body">
          Images in the{" "}
          <Link to={`/w/${ws}/media`} className="text-link underline">
            media library
          </Link>{" "}
          appear here once they are ready.
        </Trans>
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-3">
      <Tiles ws={ws} rows={rows} onPick={onPick} busy={busy} />
      {next !== null ? (
        <Button busy={more.pending} onPress={() => void more.run()}>
          <Trans id="avatar.more">Show more images</Trans>
        </Button>
      ) : null}
      {more.failure ? <ErrorPanel error={more.failure} {...authCopy("link", more.failure)} /> : null}
    </div>
  );
}

/** Choose the workspace picture from its ready images, or remove it. */
export function AvatarPicker({ workspace, canEdit }: { workspace: Workspace; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const save = useAvatarSave(workspace.id, () => setOpen(false));
  return (
    <section className="flex flex-col items-start gap-3">
      <h2 className="text-sm font-medium">
        <Trans id="avatar.title">Picture</Trans>
      </h2>
      <WorkspaceAvatar workspace={workspace} />
      {canEdit ? (
        <div className="flex flex-wrap gap-3">
          <Button data-testid="avatar-choose" onPress={() => setOpen(true)}>
            <Trans id="avatar.choose">Choose picture</Trans>
          </Button>
          {workspace.avatar ? (
            <Button data-testid="avatar-remove" busy={save.pending} onPress={() => save.pick(null)}>
              <Trans id="avatar.remove">Remove picture</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      {save.failure && !open ? (
        <ErrorPanel focusOnMount error={save.failure} {...avatarCopy(save.failure)} />
      ) : null}
      <Dialog
        title={<Trans id="avatar.choose">Choose picture</Trans>}
        isOpen={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) save.reset();
        }}
        locked={save.pending}
      >
        <ImageGrid ws={workspace.id} onPick={save.pick} busy={save.pending} />
        {save.failure && open ? (
          <ErrorPanel focusOnMount error={save.failure} {...avatarCopy(save.failure)} />
        ) : null}
      </Dialog>
    </section>
  );
}
