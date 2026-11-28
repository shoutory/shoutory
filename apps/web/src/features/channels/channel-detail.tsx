import { Trans, useLingui } from "@lingui/react/macro";
import { CONNECTION_STATES } from "@shoutory/core/channels/state";
import { useEffect, useId, useState } from "react";
import { Form } from "react-aria-components";
import { Link, useParams } from "react-router";
import { z } from "zod";
import { readZone } from "../../account/prefs";
import { useAction } from "../../auth/auth-frame";
import { ApiError, request } from "../../http/client";
import { ForbiddenPage, NotFoundPage } from "../../pages/system-pages";
import { isUnknownWorkspace, useShellData } from "../../shell/shell-data";
import { Button } from "../../ui/button";
import { DirText } from "../../ui/dir-text";
import { ErrorPanel } from "../../ui/error-panel";
import { LocalizedDateTime } from "../../ui/localized";
import { TextField } from "../../ui/text-field";
import {
  CapabilityChips,
  type Channel,
  channelSchema,
  dateOf,
  ExpiryHint,
  type ProviderInfo,
  RECONNECTABLE,
  useProviderNames,
  useWords,
} from "./channel-facts";
import { ReconnectOf, useSignIn } from "./channels-hub";

type State =
  | { status: "loading" }
  | { status: "failed"; error: ApiError }
  | { status: "ready"; row: Channel };

function useChannel(base: string) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const expired = useSignIn();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the read-again counter; `expired` follows the location.
  useEffect(() => {
    let live = true;
    request(channelSchema, base).then(
      (row) => live && setState({ status: "ready", row }),
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
  }, [base, attempt]);
  const retry = () => {
    setState({ status: "loading" });
    setAttempt((now) => now + 1);
  };
  const replace = (row: Channel) => setState({ status: "ready", row });
  return { state, retry, replace };
}

// Every refusal says nothing was changed: a call that fails changes no field of the page.
function Refused({ error, testId, id }: { error: ApiError; testId: string; id?: string }) {
  return (
    <p data-testid={testId} id={id} role="alert" className="text-sm">
      {error.state === "forbidden" ? (
        <Trans id="channels.detail.forbidden">
          You cannot change this channel. Ask an owner or admin of this workspace.
        </Trans>
      ) : (
        <Trans id="channels.detail.failed">Nothing was changed. Try again, or reload the page.</Trans>
      )}
    </p>
  );
}

function Rename({ row, base, onChange }: { row: Channel; base: string; onChange: (row: Channel) => void }) {
  const { t } = useLingui();
  const errorId = useId();
  const [value, setValue] = useState(row.nickname ?? "");
  const expired = useSignIn();
  const save = useAction(
    async () => {
      const nickname = value.trim() === "" ? null : value.trim();
      const fresh = await request(channelSchema, base, { method: "PATCH", body: { nickname } });
      setValue(fresh.nickname ?? "");
      onChange(fresh);
    },
    (error) => error.state === "session_expired" && expired(),
  );
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void save.run();
      }}
      className="flex flex-col items-start gap-3"
    >
      <TextField
        label={t({ id: "channels.detail.nickname", message: "Nickname" })}
        testId="detail-nickname-input"
        value={value}
        onChange={setValue}
        maxLength={200}
        {...(save.failure ? { "aria-describedby": errorId } : {})}
      />
      <Button type="submit" data-testid="detail-rename" busy={save.pending}>
        <Trans id="channels.detail.rename">Save nickname</Trans>
      </Button>
      {save.failure ? <Refused error={save.failure} testId="detail-rename-error" id={errorId} /> : null}
    </Form>
  );
}

function Move({
  move,
  base,
  onChange,
}: {
  move: "disable" | "enable";
  base: string;
  onChange: (row: Channel) => void;
}) {
  const expired = useSignIn();
  const run = useAction(
    async () => onChange(await request(channelSchema, `${base}/${move}`, { method: "POST" })),
    (error) => error.state === "session_expired" && expired(),
  );
  return (
    <div className="flex flex-col items-start gap-3">
      <Button data-testid={`detail-${move}`} busy={run.pending} onPress={() => void run.run()}>
        {move === "disable" ? (
          <Trans id="channels.detail.disable">Turn off</Trans>
        ) : (
          <Trans id="channels.detail.enable">Turn on</Trans>
        )}
      </Button>
      {run.failure ? <Refused error={run.failure} testId="detail-move-error" /> : null}
    </div>
  );
}

function Facts({ row, info, zone }: { row: Channel; info: ProviderInfo | undefined; zone: string }) {
  const words = useWords();
  const state = CONNECTION_STATES.find((known) => known === row.connection_state) ?? "unknown";
  const left = state === "disconnected" ? dateOf(row.disconnected_at) : null;
  const deadline = RECONNECTABLE.has(state) ? dateOf(row.reconnect_deadline) : null;
  return (
    <div className="flex flex-col gap-1">
      {row.nickname === null ? null : (
        <span data-testid="detail-nickname">
          <DirText>{row.nickname}</DirText>
        </span>
      )}
      {row.handle === null ? null : (
        <span data-testid="detail-handle">
          <DirText dir="ltr">{row.handle}</DirText>
        </span>
      )}
      <span data-testid="detail-provider" className="text-sm text-text-muted">
        <DirText>{info?.name ?? row.provider_id}</DirText>
      </span>
      <span data-testid="detail-state" data-state={state}>
        {words.state.get(state) ?? words.unknownState}
      </span>
      {left === null ? null : (
        <span data-testid="detail-disconnected" className="text-sm">
          <Trans id="channels.detail.disconnected_on">
            Disconnected on <LocalizedDateTime value={left} timeZone={zone} />
          </Trans>
        </span>
      )}
      {deadline === null ? null : (
        <span data-testid="card-deadline" className="text-sm">
          <Trans id="channels.detail.deadline">
            Reconnect by <LocalizedDateTime value={deadline} timeZone={zone} />; after that these posts become
            drafts
          </Trans>
        </span>
      )}
      <ExpiryHint row={row} zone={zone} />
      <CapabilityChips info={info} words={words} />
    </div>
  );
}

interface BodyProps {
  ws: string;
  base: string;
  row: Channel;
  info: ProviderInfo | undefined;
  onChange: (row: Channel) => void;
  onReload: () => void;
}

// A control shows only when the server's answer lists its action; none is derived from the state.
function Body({ ws, base, row, info, onChange, onReload }: BodyProps) {
  const nameId = useId();
  const has = (action: string) => row.actions.includes(action);
  return (
    <>
      <h1 id={nameId} className="font-heading text-2xl">
        <DirText>{row.display_name}</DirText>
      </h1>
      <Facts row={row} info={info} zone={readZone()} />
      <div className="flex flex-col items-start gap-5">
        {has("rename") ? <Rename row={row} base={base} onChange={onChange} /> : null}
        {has("disable") ? <Move move="disable" base={base} onChange={onChange} /> : null}
        {has("enable") ? <Move move="enable" base={base} onChange={onChange} /> : null}
        {has("reconnect") ? (
          <ReconnectOf row={row} info={info} ws={ws} nameId={nameId} onConnected={onReload} />
        ) : null}
      </div>
    </>
  );
}

function Failed({ error, retry }: { error: ApiError; retry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <ErrorPanel
        what={<Trans id="channels.detail.load_failed.what">We could not load this channel</Trans>}
        meaning={<Trans id="channels.detail.load_failed.meaning">Nothing was changed. Try again.</Trans>}
        error={error}
      />
      <Button data-testid="detail-retry" onPress={retry}>
        <Trans id="channels.hub.retry">Try again</Trans>
      </Button>
    </div>
  );
}

function ChannelDetail({ ws, id }: { ws: string; id: string }) {
  const base = `/api/v1/workspaces/${ws}/channels/${id}`;
  const { state, retry, replace } = useChannel(base);
  const info = useProviderNames(ws);
  if (state.status === "failed" && state.error.state === "not_found") return <NotFoundPage />;
  if (state.status === "failed" && state.error.state === "forbidden") return <ForbiddenPage />;
  return (
    <div data-testid="detail-state-root" data-state={state.status} className="flex flex-col gap-5">
      <Link
        to={`/w/${ws}/channels`}
        className="inline-flex min-h-6 pointer-coarse:min-h-11 items-center self-start text-link underline"
      >
        <Trans id="channels.detail.back">All channels</Trans>
      </Link>
      {state.status === "loading" ? (
        <div role="status" aria-busy="true">
          <Trans id="channels.detail.loading">Loading this channel</Trans>
        </div>
      ) : null}
      {state.status === "failed" ? <Failed error={state.error} retry={retry} /> : null}
      {state.status === "ready" ? (
        <Body
          ws={ws}
          base={base}
          row={state.row}
          info={info.get(state.row.provider_id)}
          onChange={replace}
          onReload={retry}
        />
      ) : null}
    </div>
  );
}

export function ChannelDetailPage() {
  const { ws = "", channelId = "" } = useParams();
  const shell = useShellData();
  if (isUnknownWorkspace(shell, ws) || !z.uuid().safeParse(channelId).success) return <NotFoundPage />;
  return <ChannelDetail key={`${ws}/${channelId}`} ws={ws} id={channelId} />;
}
