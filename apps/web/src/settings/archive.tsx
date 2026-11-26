import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { useParams, useRevalidator } from "react-router";
import { z } from "zod";
import { request } from "../http/client";
import { useShellData, type Workspace } from "../shell/shell-data";
import { Button } from "../ui/button";
import { DirText } from "../ui/dir-text";
import { ErrorPanel } from "../ui/error-panel";
import { ConfirmChange, changeCopy, useChange } from "./member-actions";
import { ADMIN_RANK, rankOf } from "./roles";

const answer = z.object({ id: z.string(), archived_at: z.string().nullable() });

// The archived state shown is the one the lists read back after the answer, never a local guess. The pressed control is
// replaced or hidden by that answer, so focus moves to the page once the dialog has closed.
function useArchiveCall(workspace: Workspace, action: "archive" | "unarchive") {
  const revalidator = useRevalidator();
  return async () => {
    await request(answer, `/api/v1/workspaces/${workspace.id}/${action}`, { method: "POST" });
    await revalidator.revalidate();
    requestAnimationFrame(() => document.getElementById("main")?.focus());
  };
}

function useCanArchive(workspace: Workspace) {
  const { t } = useLingui();
  const allowed = rankOf(workspace.role) >= ADMIN_RANK;
  const why = t({ id: "archive.need_admin", message: "Only an owner or admin can archive or restore." });
  return allowed ? {} : { "aria-disabled": true, reason: why };
}

function RestoreButton({ workspace }: { workspace: Workspace }) {
  const blocked = useCanArchive(workspace);
  const restore = useChange(useArchiveCall(workspace, "unarchive"));
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        data-testid="workspace-restore"
        busy={restore.pending}
        aria-disabled={restore.pending || !restore.online}
        onPress={() => void restore.run()}
        {...blocked}
      >
        <Trans id="archive.restore">Restore</Trans>
        <span className="sr-only">
          {" "}
          <DirText>{workspace.name}</DirText>
        </span>
      </Button>
      {restore.failure ? (
        <ErrorPanel focusOnMount error={restore.failure} {...changeCopy(restore.failure)} />
      ) : null}
    </div>
  );
}

function ArchiveButton({ workspace }: { workspace: Workspace }) {
  const blocked = useCanArchive(workspace);
  const [open, setOpen] = useState(false);
  const run = useArchiveCall(workspace, "archive");
  const { name } = workspace;
  return (
    <>
      <Button data-testid="workspace-archive" onPress={() => setOpen(true)} {...blocked}>
        <Trans id="archive.archive">Archive</Trans>
        <span className="sr-only">
          {" "}
          <DirText>{name}</DirText>
        </span>
      </Button>
      <ConfirmChange
        title={
          <Trans id="archive.title">
            Archive <DirText>{name}</DirText>?
          </Trans>
        }
        label={<Trans id="archive.archive">Archive</Trans>}
        isOpen={open}
        onClose={() => setOpen(false)}
        run={run}
      >
        <Trans id="archive.impact">
          The workspace becomes read-only and nothing in it is published while it is archived. Posts already
          being published finish. Its history stays. Restore undoes this; a post whose time passed beyond the
          late-publish window while archived is marked missed.
        </Trans>
      </ConfirmChange>
    </>
  );
}

/** Archive, or Restore when archived: one control for the clients list and the workspace settings. */
export function ArchiveControl({ workspace }: { workspace: Workspace }) {
  if (workspace.organization_type === "personal") return null;
  return workspace.archived_at ? (
    <RestoreButton workspace={workspace} />
  ) : (
    <ArchiveButton workspace={workspace} />
  );
}

export function ArchivedBanner() {
  const { ws } = useParams();
  const data = useShellData();
  const current = "error" in data ? undefined : data.workspaces.find((workspace) => workspace.id === ws);
  if (!current?.archived_at) return null;
  return (
    <section
      data-testid="archived-banner"
      className="flex flex-col items-start gap-3 rounded-md border border-border bg-surface p-4"
    >
      <p>
        <Trans id="archive.banner">
          <DirText>{current.name}</DirText> is archived. It is read-only and nothing in it is published.
        </Trans>
      </p>
      <RestoreButton workspace={current} />
    </section>
  );
}
