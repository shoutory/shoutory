import { Trans, useLingui } from "@lingui/react/macro";
import { ROLE_PERMISSIONS } from "@shoutory/core/authz";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { z } from "zod";
import { type Loaded, useLoad } from "../../account/use-load";
import { type ApiError, request, requestPages } from "../../http/client";
import { NotFoundPage } from "../../pages/system-pages";
import { useShellData, type Workspace } from "../../shell/shell-data";
import { ErrorPanel } from "../../ui/error-panel";
import { channelSchema } from "../channels/channel-facts";
import { Composer, type Initial, type Refs } from "./composer-body";
import {
  type Detail,
  detailSchema,
  docOfDetail,
  EMPTY_DOC,
  profileSchema,
  providerSchema,
} from "./composer-data";

const providerList = z.array(providerSchema);
const channelList = z.array(channelSchema);
const nobody = (): Promise<null> => Promise.resolve(null);
const detailOrNone = z.nullable(detailSchema);

// A new post has nothing to read; the read of a saved one is repeated after each save to learn what it may do.
function useDetail(base: string, postId: string | undefined) {
  const read: (schema: z.ZodType<Detail | null>, path: string) => Promise<Detail | null> =
    postId === undefined ? nobody : request;
  return useLoad(detailOrNone, `${base}/posts/${postId ?? "new"}`, 0, read);
}

function Failure({ error }: { error: ApiError }) {
  return (
    <ErrorPanel
      focusOnMount
      error={error}
      what={<Trans id="composer.load.what">We could not open the composer</Trans>}
      meaning={<Trans id="composer.load.meaning">Nothing was changed. Try again.</Trans>}
    />
  );
}

function Loading() {
  return (
    <p role="status">
      <Trans id="system.loading">Loading</Trans>
    </p>
  );
}

function useBoot(routeId: string | undefined, detail: Loaded<Detail | null>, refsReady: boolean) {
  const [boot, setBoot] = useState<Initial | null>(null);
  const known = useRef(routeId);
  const created = useRef<string | undefined>(undefined);
  // The page the composer made itself is the one it already shows; any other page starts the composer over.
  useEffect(() => {
    if (routeId === known.current) return;
    known.current = routeId;
    if (routeId !== undefined && routeId === created.current) return;
    created.current = undefined;
    setBoot(null);
  }, [routeId]);
  useEffect(() => {
    if (boot !== null || !refsReady || detail.status !== "done") return;
    const data = detail.data;
    if (routeId === undefined && data === null) setBoot({ postId: undefined, version: null, doc: EMPTY_DOC });
    if (routeId !== undefined && data?.id === routeId) {
      const doc = docOfDetail(data);
      if (doc) setBoot({ postId: routeId, version: data.current_version_id, doc });
    }
  }, [boot, routeId, detail, refsReady]);
  return {
    boot,
    markCreated: (id: string) => {
      created.current = id;
    },
  };
}

const permissions: Readonly<Record<string, readonly string[] | undefined>> = ROLE_PERMISSIONS;

function useRefs(base: string) {
  const providers = useLoad(providerList, `${base}/providers`);
  const channels = useLoad(channelList, `${base}/channels?limit=100`, 0, requestPages);
  const profile = useLoad(profileSchema, base);
  const refs = useMemo<Refs | null>(
    () =>
      providers.state.status === "done" && channels.state.status === "done" && profile.state.status === "done"
        ? {
            providers: new Map(providers.state.data.map((one) => [one.id, one])),
            channels: channels.state.data,
            zone: profile.state.data.default_tz,
          }
        : null,
    [providers.state, channels.state, profile.state],
  );
  const failed = [providers.state, channels.state, profile.state].find((state) => state.status === "failed");
  return { refs, failed };
}

// The role decides what is offered; the server still decides every write.
function useMayEdit(workspace: Workspace) {
  const { t } = useLingui();
  const allowed = permissions[workspace.role]?.includes("posts.edit") ?? false;
  const canEdit = allowed && !workspace.archived_at;
  const reason = allowed
    ? t({ id: "composer.readonly.archived", message: "View only: this workspace is archived." })
    : t({
        id: "composer.readonly.role",
        message: "View only: your role in this workspace cannot change posts.",
      });
  return { canEdit, reason: canEdit ? null : reason };
}

function ComposerLoader({ workspace, postId }: { workspace: Workspace; postId: string | undefined }) {
  const base = `/api/v1/workspaces/${workspace.id}`;
  const { refs, failed } = useRefs(base);
  const { state: detail, refresh } = useDetail(base, postId);
  const { boot, markCreated } = useBoot(postId, detail, refs !== null);
  const failure = failed ?? (detail.status === "failed" ? detail : undefined);
  const { canEdit, reason } = useMayEdit(workspace);
  return (
    <>
      <h1 className="font-heading text-2xl">
        {postId === undefined ? (
          <Trans id="composer.title">New post</Trans>
        ) : (
          <Trans id="composer.edit.title">Edit post</Trans>
        )}
      </h1>
      {failure?.status === "failed" ? <Failure error={failure.error} /> : null}
      {boot && refs ? (
        <Composer
          workspace={workspace}
          refs={refs}
          initial={boot}
          onCreated={markCreated}
          onRefresh={refresh}
          targets={detail.status === "done" && detail.data ? detail.data.targets : []}
          canEdit={canEdit}
          reason={reason}
        />
      ) : failure ? null : (
        <Loading />
      )}
    </>
  );
}

export function ComposerPage() {
  const { ws, postId } = useParams();
  const data = useShellData();
  if ("error" in data) return null;
  const workspace = data.workspaces.find((candidate) => candidate.id === ws);
  return workspace ? <ComposerLoader workspace={workspace} postId={postId} /> : <NotFoundPage />;
}
