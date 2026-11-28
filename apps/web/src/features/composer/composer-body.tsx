import { Trans } from "@lingui/react/macro";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import { ApiError, request } from "../../http/client";
import type { Workspace } from "../../shell/shell-data";
import { Banner } from "../../ui/banner";
import { ErrorPanel } from "../../ui/error-panel";
import { type Channel, RECONNECTABLE } from "../channels/channel-facts";
import { ChannelPicker } from "./channel-picker";
import {
  type Doc,
  type Issue,
  issuesOf,
  type Provider,
  type Target,
  toDraft,
  withChannels,
} from "./composer-data";
import { useSaver } from "./composer-save";
import { ConflictDialog } from "./conflict-dialog";
import { ValidationPanel } from "./counters";
import { Preview } from "./preview";
import { PublishBar } from "./publish-bar";
import { RestoreOffer, SaveFailure, SaveIndicator } from "./save-status";
import { type Channels, VariantEditor } from "./variant-editor";
import { VersionsPanel } from "./versions-panel";

export interface Initial {
  postId: string | undefined;
  version: string | null;
  doc: Doc;
}

export interface Refs {
  providers: ReadonlyMap<string, Provider>;
  channels: readonly Channel[];
  zone: string;
}

const createdSchema = z.object({ id: z.string() });

function useChannelFacts({ providers, channels }: Refs): Channels {
  return useMemo(() => {
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    return {
      nameOf: (id) => {
        const channel = byId.get(id);
        return channel?.nickname ?? channel?.display_name ?? id;
      },
      providerOf: (id) => providers.get(byId.get(id)?.provider_id ?? ""),
      okOf: (id) => !RECONNECTABLE.has(byId.get(id)?.connection_state ?? ""),
    };
  }, [providers, channels]);
}

// The tab being edited, and the jump from a check to the field it names.
function useFields(doc: Doc, selected: readonly string[]) {
  const [tab, setTab] = useState("all");
  const [focus, setFocus] = useState<string | null>(null);
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
  return { tab: tab === "all" || selected.includes(tab) ? tab : "all", setTab, go };
}

function SaveSurface({
  saver,
  workspace,
  doc,
  nameOf,
}: {
  saver: ReturnType<typeof useSaver>;
  workspace: string;
  doc: Doc;
  nameOf: (id: string) => string;
}) {
  return (
    <>
      <RestoreOffer offer={saver.offer} onRestore={saver.restore} onDiscard={saver.discard} />
      {saver.failure ? <SaveFailure error={saver.failure} onRetry={() => void saver.saveNow()} /> : null}
      {saver.conflict !== null && saver.postId ? (
        <ConflictDialog
          base={`/api/v1/workspaces/${workspace}`}
          postId={saver.postId}
          theirs={saver.conflict}
          mine={doc}
          nameOf={nameOf}
          onKeepMine={() => saver.keepMine(saver.conflict ?? "")}
          onUseTheirs={(theirs) => saver.adopt(theirs, saver.conflict ?? "")}
        />
      ) : null}
    </>
  );
}

// The copy of what is on screen as a new draft, opened for editing.
function useDuplicate(workspace: string, doc: Doc) {
  const navigate = useNavigate();
  const running = useRef(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const duplicate = async () => {
    if (running.current) return;
    running.current = true;
    setFailure(null);
    try {
      const made = await request(createdSchema, `/api/v1/workspaces/${workspace}/posts`, {
        method: "POST",
        body: { draft: toDraft(doc) },
      });
      void navigate(`/w/${workspace}/posts/${made.id}/edit`);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setFailure(error);
    } finally {
      running.current = false;
    }
  };
  return { duplicate: () => void duplicate(), failure };
}

// The document being written and its saves; a new post moves to its own address once the server has made it.
function useDraft(args: {
  workspace: string;
  initial: Initial;
  canEdit: boolean;
  onCreated: (id: string) => void;
  onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const [doc, setDoc] = useState(args.initial.doc);
  const saver = useSaver({
    workspace: args.workspace,
    postId: args.initial.postId,
    version: args.initial.version,
    doc,
    canSave: args.canEdit,
    onCreated: (id) => {
      args.onCreated(id);
      void navigate(`/w/${args.workspace}/posts/${id}/edit`, { replace: true });
    },
    onReplace: setDoc,
  });
  const { savedAt } = saver;
  const refresh = useRef(args.onRefresh);
  refresh.current = args.onRefresh;
  // What the server now says each target may do follows each save.
  useEffect(() => {
    if (savedAt !== null) refresh.current();
  }, [savedAt]);
  return { doc, setDoc, saver };
}

function Fields({
  workspace,
  refs,
  doc,
  onDoc,
  onUpdate,
  onChannels,
  channels,
  view,
  refused,
  issues,
  readOnly,
  onBlur,
}: {
  workspace: string;
  refs: Refs;
  doc: Doc;
  onDoc: (doc: Doc) => void;
  onUpdate: (change: (doc: Doc) => Doc) => void;
  onChannels: (ids: string[]) => void;
  channels: Channels;
  view: { tab: string; setTab: (tab: string) => void; go: (issue: Issue) => void };
  refused: readonly Issue[];
  issues: readonly Issue[];
  readOnly: boolean;
  onBlur: () => void;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex flex-col gap-6">
        <ChannelPicker
          workspace={workspace}
          channels={refs.channels}
          providers={refs.providers}
          selected={doc.variants.map((variant) => variant.channelId)}
          onChange={onChannels}
          readOnly={readOnly}
        />
        <VariantEditor
          doc={doc}
          onDoc={onDoc}
          onUpdate={onUpdate}
          workspace={workspace}
          channels={channels}
          tab={view.tab}
          onTab={view.setTab}
          refused={refused}
          readOnly={readOnly}
          onBlur={onBlur}
        />
        <ValidationPanel issues={issues} nameOf={channels.nameOf} onGo={view.go} />
      </div>
      <Preview doc={doc} nameOf={channels.nameOf} tab={view.tab} />
    </div>
  );
}

function ReadOnlyNote({ reason }: { reason: string | null }) {
  if (reason === null) return null;
  return (
    <Banner tone="info">
      <span data-testid="composer-readonly">{reason}</span>
    </Banner>
  );
}

function CopyFailure({ error }: { error: ApiError }) {
  return (
    <ErrorPanel
      error={error}
      what={<Trans id="composer.copy.what">We could not make a copy</Trans>}
      meaning={<Trans id="composer.copy.meaning">Nothing was changed. Try again.</Trans>}
    />
  );
}

export function Composer({
  workspace,
  refs,
  initial,
  canEdit,
  reason,
  targets,
  onCreated,
  onRefresh,
}: {
  workspace: Workspace;
  refs: Refs;
  initial: Initial;
  canEdit: boolean;
  reason: string | null;
  targets: readonly Target[];
  onCreated: (id: string) => void;
  onRefresh: () => void;
}) {
  const [refused, setRefused] = useState<Issue[]>([]);
  const channels = useChannelFacts(refs);
  const { doc, setDoc, saver } = useDraft({
    workspace: workspace.id,
    initial,
    canEdit,
    onCreated,
    onRefresh,
  });
  const copy = useDuplicate(workspace.id, doc);
  const issues = useMemo(() => issuesOf(doc, channels.providerOf), [doc, channels]);
  const selected = doc.variants.map((variant) => variant.channelId);
  const { tab: activeTab, setTab, go } = useFields(doc, selected);
  return (
    <div className="flex flex-col gap-6">
      <ReadOnlyNote reason={reason} />
      <SaveSurface saver={saver} workspace={workspace.id} doc={doc} nameOf={channels.nameOf} />
      <Fields
        workspace={workspace.id}
        refs={refs}
        doc={doc}
        onDoc={(next) => {
          setDoc(next);
          setRefused([]);
        }}
        onUpdate={(change) => {
          setDoc(change);
          setRefused([]);
        }}
        onChannels={(ids) => setDoc((now) => withChannels(now, ids))}
        channels={channels}
        view={{ tab: activeTab, setTab, go }}
        refused={refused}
        issues={issues}
        readOnly={!canEdit}
        onBlur={() => void saver.saveNow()}
      />
      {copy.failure ? <CopyFailure error={copy.failure} /> : null}
      <Footer
        saver={saver}
        workspace={workspace.id}
        zone={refs.zone}
        channels={channels}
        selected={selected}
        targets={targets}
        issues={issues}
        canEdit={canEdit}
        actions={{ onIssues: setRefused, onDuplicate: copy.duplicate, onRefresh }}
      />
    </div>
  );
}

// The save state, the version history and the controls that schedule or publish.
function Footer({
  saver,
  workspace,
  zone,
  channels,
  selected,
  targets,
  issues,
  canEdit,
  actions,
}: {
  saver: ReturnType<typeof useSaver>;
  workspace: string;
  zone: string;
  channels: Channels;
  selected: readonly string[];
  targets: readonly Target[];
  issues: readonly Issue[];
  canEdit: boolean;
  actions: { onIssues: (issues: Issue[]) => void; onDuplicate: () => void; onRefresh: () => void };
}) {
  return (
    <>
      <SaveIndicator state={saver.state} savedAt={saver.savedAt} online={saver.online} />
      {saver.postId ? (
        <VersionsPanel
          workspace={workspace}
          postId={saver.postId}
          nameOf={channels.nameOf}
          beforeRestore={saver.saveNow}
          currentVersion={saver.currentVersion}
          onRestored={saver.adopt}
        />
      ) : null}
      {canEdit ? (
        <PublishBar
          workspace={workspace}
          postId={saver.postId}
          zone={zone}
          selected={selected}
          targets={targets}
          channelOk={channels.okOf}
          issues={issues}
          saveState={saver.state}
          online={saver.online}
          pending={saver.pending}
          saveNow={saver.saveNow}
          onIssues={actions.onIssues}
          onEdit={actions.onRefresh}
          onDuplicate={actions.onDuplicate}
          onChanged={actions.onRefresh}
        />
      ) : null}
    </>
  );
}
