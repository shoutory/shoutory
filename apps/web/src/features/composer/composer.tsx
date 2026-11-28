import { Trans, useLingui } from "@lingui/react/macro";
import { ROLE_PERMISSIONS } from "@shoutory/core/authz";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { z } from "zod";
import { type Loaded, useLoad } from "../../account/use-load";
import { type ApiError, request, requestPages } from "../../http/client";
import { NotFoundPage } from "../../pages/system-pages";
import { useShellData, type Workspace } from "../../shell/shell-data";
import { Banner } from "../../ui/banner";
import { ErrorPanel } from "../../ui/error-panel";
import { type Channel, channelSchema } from "../channels/channel-facts";
import { ChannelPicker } from "./channel-picker";
import {
  type Detail,
  type Doc,
  detailSchema,
  docOfDetail,
  EMPTY_DOC,
  type Issue,
  issuesOf,
  type Provider,
  providerSchema,
  withChannels,
} from "./composer-data";
import { ValidationPanel } from "./counters";
import { Preview } from "./preview";
import { type Channels, VariantEditor } from "./variant-editor";

interface Initial {
  postId: string | undefined;
  version: string | null;
  doc: Doc;
}

interface Refs {
  providers: ReadonlyMap<string, Provider>;
  channels: readonly Channel[];
}

function useChannelFacts({ providers, channels }: Refs): Channels {
  return useMemo(() => {
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    return {
      nameOf: (id) => {
        const channel = byId.get(id);
        return channel?.nickname ?? channel?.display_name ?? id;
      },
      providerOf: (id) => providers.get(byId.get(id)?.provider_id ?? ""),
    };
  }, [providers, channels]);
}

function Composer({
  workspace,
  refs,
  initial,
  canEdit,
  reason,
}: {
  workspace: Workspace;
  refs: Refs;
  initial: Initial;
  canEdit: boolean;
  reason: string | null;
}) {
  const [doc, setDoc] = useState(initial.doc);
  const [tab, setTab] = useState("all");
  const [focus, setFocus] = useState<string | null>(null);
  const [refused] = useState<Issue[]>([]);
  const channels = useChannelFacts(refs);
  const issues = useMemo(() => issuesOf(doc, channels.providerOf), [doc, channels]);
  const selected = doc.variants.map((variant) => variant.channelId);
  const activeTab = tab === "all" || selected.includes(tab) ? tab : "all";

  useEffect(() => {
    if (focus === null) return;
    document.querySelector<HTMLElement>(`[data-field="${focus}"]`)?.focus();
    setFocus(null);
  }, [focus]);

  const go = (issue: Issue) => {
    const variant = doc.variants.find((one) => one.channelId === issue.channelId);
    const own = issue.key !== "text" || variant?.override !== null;
    setTab(own ? issue.channelId : "all");
    setFocus(own ? `${issue.key}:${issue.channelId}` : "text:all");
  };

  return (
    <div className="flex flex-col gap-6">
      {reason === null ? null : (
        <Banner tone="info">
          <span data-testid="composer-readonly">{reason}</span>
        </Banner>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col gap-6">
          <ChannelPicker
            workspace={workspace.id}
            channels={refs.channels}
            providers={refs.providers}
            selected={selected}
            onChange={(ids) => setDoc((now) => withChannels(now, ids))}
            readOnly={!canEdit}
          />
          <VariantEditor
            doc={doc}
            onDoc={setDoc}
            channels={channels}
            tab={activeTab}
            onTab={setTab}
            refused={refused}
            readOnly={!canEdit}
            onBlur={() => undefined}
          />
          <ValidationPanel issues={issues} nameOf={channels.nameOf} onGo={go} />
        </div>
        <Preview doc={doc} nameOf={channels.nameOf} tab={activeTab} />
      </div>
    </div>
  );
}

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
  useEffect(() => {
    if (routeId !== known.current) {
      known.current = routeId;
      setBoot((now) => (now?.postId === routeId ? now : null));
    }
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
  return boot;
}

const permissions: Readonly<Record<string, readonly string[] | undefined>> = ROLE_PERMISSIONS;

function ComposerLoader({ workspace, postId }: { workspace: Workspace; postId: string | undefined }) {
  const { t } = useLingui();
  const base = `/api/v1/workspaces/${workspace.id}`;
  const providers = useLoad(providerList, `${base}/providers`);
  const channels = useLoad(channelList, `${base}/channels?limit=100`, 0, requestPages);
  const loaded = useDetail(base, postId);
  const detail = loaded.state;
  const refsReady = providers.state.status === "done" && channels.state.status === "done";
  const boot = useBoot(postId, detail, refsReady);
  const failure = [providers.state, channels.state, detail].find((state) => state.status === "failed");
  const allowed = permissions[workspace.role]?.includes("posts.edit") ?? false;
  const canEdit = allowed && !workspace.archived_at;
  const refs = useMemo(
    () =>
      providers.state.status === "done" && channels.state.status === "done"
        ? {
            providers: new Map(providers.state.data.map((one) => [one.id, one])),
            channels: channels.state.data,
          }
        : null,
    [providers.state, channels.state],
  );
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
          canEdit={canEdit}
          reason={
            canEdit
              ? null
              : allowed
                ? t({ id: "composer.readonly.archived", message: "View only: this workspace is archived." })
                : t({
                    id: "composer.readonly.role",
                    message: "View only: your role in this workspace cannot change posts.",
                  })
          }
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
