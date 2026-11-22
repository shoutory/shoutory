import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { z } from "zod";
import { type Loaded, useLoad } from "../../account/use-load";
import { type ShellData, useShellData } from "../../shell/shell-data";
import { Banner } from "../../ui/banner";
import { DirText } from "../../ui/dir-text";
import { ErrorPanel } from "../../ui/error-panel";

// Where the OAuth callback sends the browser (the server writes `reason`, `channel`, `workspace` and, for a provider's
// error, `message`). Anything else in the address is a generic failure. "Connected" is shown only after this page's own
// read of the channel says so; a provider's words are text in Details, cut at 200 code points, never the headline.

const REASONS = [
  "start_again",
  "refused",
  "provider_error",
  "failed",
  "sign_in",
  "rate_limited",
  "unavailable",
  "wrong_account",
] as const;
type Reason = (typeof REASONS)[number];
const uuid = z.uuid();
const MESSAGE_LIMIT = 200;

type Parsed =
  | { kind: "generic" }
  | { kind: "channel"; channel: string; workspace: string | undefined }
  | {
      kind: "reason";
      reason: Reason;
      message: string | undefined;
      channel: string | undefined;
      workspace: string | undefined;
    };
const GENERIC: Parsed = { kind: "generic" };

// Each key is read once: a repeated key, a reason beside a channel (except a wrong account), a message anywhere but
// beside a provider's error, or a channel that is not a UUID is not what the server writes.
function parse(params: URLSearchParams): Parsed {
  if (["reason", "channel", "workspace", "message"].some((key) => params.getAll(key).length > 1))
    return GENERIC;
  const [reason, channel, workspace, message] = ["reason", "channel", "workspace", "message"].map(
    (key) => params.get(key) ?? undefined,
  );
  if (channel !== undefined && !uuid.safeParse(channel).success) return GENERIC;
  if (reason === undefined) {
    return channel !== undefined && message === undefined ? { kind: "channel", channel, workspace } : GENERIC;
  }
  const known = REASONS.find((candidate) => candidate === reason);
  if (known === undefined || (message !== undefined) !== (known === "provider_error") || message === "") {
    return GENERIC;
  }
  if ((channel !== undefined) !== (known === "wrong_account")) return GENERIC;
  return { kind: "reason", reason: known, message, channel, workspace };
}

// A workspace counts only when it is a UUID and the id of an entry of the shell's list, matched exactly.
function listed(shell: ShellData, workspace: string | undefined): string | undefined {
  if (workspace === undefined || "error" in shell || !uuid.safeParse(workspace).success) return undefined;
  return shell.workspaces.find((entry) => entry.id === workspace)?.id;
}

function Heading({ children, focus }: { children: ReactNode; focus: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <h1 ref={ref} tabIndex={-1} data-testid="outcome-heading" className="font-heading text-2xl">
      {children}
    </h1>
  );
}

interface View {
  outcome: string;
  tone: "info" | "attention" | "danger";
  headline: ReactNode;
  meaning: ReactNode;
  detail?: ReactNode;
}

function Outcome({ view, link, focus = false }: { view: View; link: ReactNode; focus?: boolean }) {
  const heading = <Heading focus={focus}>{view.headline}</Heading>;
  const meaning = <span data-testid="connect-meaning">{view.meaning}</span>;
  return (
    <div
      data-testid="connect-outcome"
      data-outcome={view.outcome}
      className="mx-auto flex max-w-prose flex-col gap-5 px-5 py-10"
    >
      {view.tone === "danger" ? (
        <ErrorPanel what={heading} meaning={meaning} detail={view.detail} />
      ) : (
        <Banner tone={view.tone} announce={false}>
          {heading}
          <p>{meaning}</p>
        </Banner>
      )}
      {link}
    </div>
  );
}

const danger = (outcome: string, headline: ReactNode, meaning: ReactNode): View => ({
  outcome,
  tone: "danger",
  headline,
  meaning,
});
const VIEWS = {
  generic: danger(
    "generic",
    <Trans id="connect.result.generic.headline">We could not read this result</Trans>,
    <Trans id="connect.result.generic.meaning">Open your channels to see their state.</Trans>,
  ),
  unconfirmed: danger(
    "unconfirmed",
    <Trans id="connect.result.unconfirmed.headline">We could not confirm this connection</Trans>,
    <Trans id="connect.result.unconfirmed.meaning">Open your channels to see whether it was added.</Trans>,
  ),
  start_again: danger(
    "start_again",
    <Trans id="connect.result.start_again.headline">This sign-in took too long or was already used</Trans>,
    <Trans id="connect.result.start_again.meaning">
      Nothing was saved. Start the connection again from your channels.
    </Trans>,
  ),
  refused: danger(
    "refused",
    <Trans id="connect.result.refused.headline">This connection was not allowed</Trans>,
    <Trans id="connect.result.refused.meaning">Nothing was saved. Start again from your channels.</Trans>,
  ),
  failed: danger(
    "failed",
    <Trans id="connect.result.failed.headline">The connection could not be finished</Trans>,
    <Trans id="connect.result.failed.meaning">Nothing was saved. Try again in a few minutes.</Trans>,
  ),
  sign_in: danger(
    "sign_in",
    <Trans id="connect.result.sign_in.headline">Sign in to finish</Trans>,
    <Trans id="connect.result.sign_in.meaning">
      Your session ended during the connection. Sign in and start again.
    </Trans>,
  ),
  rate_limited: danger(
    "rate_limited",
    <Trans id="connect.result.rate_limited.headline">Too many connection attempts</Trans>,
    <Trans id="connect.result.rate_limited.meaning">Wait a few minutes, then start again.</Trans>,
  ),
  unavailable: danger(
    "unavailable",
    <Trans id="connect.result.unavailable.headline">Connecting is not available right now</Trans>,
    <Trans id="connect.result.unavailable.meaning">Nothing was saved. Try again later.</Trans>,
  ),
  pending: {
    outcome: "pending",
    tone: "info",
    headline: <Trans id="connect.result.pending.headline">Finishing the connection</Trans>,
    meaning: <Trans id="connect.result.pending.meaning">Checking the channel with the server.</Trans>,
  },
} satisfies Record<string, View>;

function providerError(message: string): View {
  const words = [...message].slice(0, MESSAGE_LIMIT).join("");
  return {
    ...danger(
      "provider_error",
      <Trans id="connect.result.provider_error.headline">The platform stopped the connection</Trans>,
      <Trans id="connect.result.provider_error.meaning">Nothing was saved. Its own words are below.</Trans>,
    ),
    detail: (
      <div className="flex flex-col gap-1 pt-3">
        <span data-testid="provider-message-label">
          <Trans id="connect.result.provider_message_label">What the platform said</Trans>
        </span>
        <span data-testid="provider-message">
          <DirText>{words}</DirText>
        </span>
      </div>
    ),
  };
}

function wrongAccount(handle: string | null | undefined): View {
  return danger(
    "wrong_account",
    <Trans id="connect.result.wrong_account.headline">This is a different account</Trans>,
    handle ? (
      <Trans id="connect.result.wrong_account.meaning">
        <bdi dir="ltr" data-testid="expected-handle">
          {handle}
        </bdi>{" "}
        is connected here. Posts would go to another account. Sign in with that account and try again.
      </Trans>
    ) : (
      <Trans id="connect.result.wrong_account.meaning_no_handle">
        Posts would go to another account. Sign in with the channel's account and try again.
      </Trans>
    ),
  );
}

const channelSchema = z.object({
  connection_state: z.string(),
  display_name: z.string(),
  nickname: z.string().nullable(),
  handle: z.string().nullable(),
});
type Channel = z.infer<typeof channelSchema>;

function StateMeaning({ state }: { state: string }) {
  const { t } = useLingui();
  const words = new Map([
    ["needs_reconnect", t({ id: "connect.result.state.needs_reconnect", message: "Reconnect needed" })],
    ["disconnected", t({ id: "connect.result.state.disconnected", message: "Disconnected" })],
    ["revoked_by_provider", t({ id: "connect.result.state.revoked_by_provider", message: "Access removed" })],
    ["disabled", t({ id: "connect.result.state.disabled", message: "Turned off" })],
  ]);
  const word = words.get(state) ?? t({ id: "connect.result.state.unknown", message: "Unknown" });
  return (
    <span data-testid="channel-state" data-state={state}>
      <Trans id="connect.result.channel_state.meaning">The channel reads as: {word}.</Trans>
    </span>
  );
}

// What a channel read said: a connected channel is the success, any other state is shown as that state.
function viewOfChannel(channel: Channel): View {
  const name = channel.nickname ?? channel.display_name;
  if (channel.connection_state === "connected") {
    return {
      outcome: "connected",
      tone: "info",
      headline: (
        <Trans id="connect.result.connected.headline">
          <bdi data-testid="connected-name">{name}</bdi> is connected
        </Trans>
      ),
      meaning: (
        <Trans id="connect.result.connected.meaning">You can now schedule posts to this channel.</Trans>
      ),
    };
  }
  return {
    outcome: "channel_state",
    tone: "attention",
    headline: (
      <Trans id="connect.result.channel_state.headline">
        <DirText>{name}</DirText> is not ready
      </Trans>
    ),
    meaning: <StateMeaning state={channel.connection_state} />,
  };
}

function viewOfRead(state: Loaded<Channel>, wrong: boolean): View {
  if (state.status === "loading") return VIEWS.pending;
  if (state.status === "failed") return wrong ? wrongAccount(undefined) : VIEWS.unconfirmed;
  return wrong ? wrongAccount(state.data.handle) : viewOfChannel(state.data);
}

// The polite region is mounted before its text and stays, so the announcement is made when the text arrives.
function ChannelRead({
  workspace,
  channel,
  wrong,
  link,
}: {
  workspace: string;
  channel: string;
  wrong: boolean;
  link: ReactNode;
}) {
  const { state } = useLoad(channelSchema, `/api/v1/workspaces/${workspace}/channels/${channel}`);
  const view = viewOfRead(state, wrong);
  const done = state.status !== "loading";
  return (
    <>
      <div role="status" aria-live="polite" data-testid="connect-live" className="sr-only">
        {view.outcome === "connected" ? view.meaning : null}
      </div>
      <Outcome key={view.outcome} view={view} link={done ? link : null} focus={done} />
    </>
  );
}

export function ConnectResultPage() {
  const [params] = useSearchParams();
  const shell = useShellData();
  const parsed = parse(params);
  const workspace = parsed.kind === "generic" ? undefined : listed(shell, parsed.workspace);
  const link = (
    <Link
      to={workspace === undefined ? "/" : `/w/${workspace}/channels`}
      data-testid="connect-link"
      className="inline-flex min-h-6 pointer-coarse:min-h-11 items-center self-start text-link underline"
    >
      {workspace === undefined ? (
        <Trans id="connect.result.link.home">Go to home</Trans>
      ) : (
        <Trans id="connect.result.link.channels">Back to channels</Trans>
      )}
    </Link>
  );
  if (parsed.kind === "generic") return <Outcome view={VIEWS.generic} link={link} />;
  if (parsed.kind === "channel") {
    if (workspace === undefined) return <Outcome view={VIEWS.unconfirmed} link={link} />;
    return <ChannelRead workspace={workspace} channel={parsed.channel} wrong={false} link={link} />;
  }
  if (parsed.reason === "wrong_account") {
    if (workspace === undefined || parsed.channel === undefined) {
      return <Outcome view={wrongAccount(undefined)} link={link} />;
    }
    return <ChannelRead workspace={workspace} channel={parsed.channel} wrong link={link} />;
  }
  const view =
    parsed.reason === "provider_error" ? providerError(parsed.message ?? "") : VIEWS[parsed.reason];
  return <Outcome view={view} link={link} />;
}
