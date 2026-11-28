import { Trans, useLingui } from "@lingui/react/macro";
import { Checkbox, CheckboxGroup } from "react-aria-components";
import { Link, useNavigate } from "react-router";
import { DirText } from "../../ui/dir-text";
import { EmptyState } from "../../ui/empty-state";
import { CapabilityChips, type Channel, RECONNECTABLE, useWords } from "../channels/channel-facts";
import type { Provider } from "./composer-data";

function Box() {
  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-sm border-2 border-border-control bg-surface text-sm group-data-selected:bg-primary group-data-selected:text-on-primary group-data-focus-visible:outline-2 group-data-focus-visible:outline-offset-2 group-data-focus-visible:outline-focus"
    >
      <span className="hidden group-data-selected:inline group-data-indeterminate:inline">-</span>
    </span>
  );
}

function PlugIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
      <path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3" />
    </svg>
  );
}

function ChannelState({ channel }: { channel: Channel }) {
  const words = useWords();
  if (RECONNECTABLE.has(channel.connection_state)) {
    return (
      <span data-testid="picker-reconnect" className="flex items-center gap-2 text-sm text-attention">
        <PlugIcon />
        <Trans id="composer.picker.reconnect_needed">Reconnect needed</Trans>
      </span>
    );
  }
  const word =
    channel.connection_state === "connected"
      ? words.health.get(channel.health ?? "unknown")
      : words.state.get(channel.connection_state);
  return (
    <span data-testid="picker-state" className="flex items-center gap-2 text-sm text-text-muted">
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      {word ?? words.unknownState}
    </span>
  );
}

function ChannelRow({ channel, workspace }: { channel: Channel; workspace: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <Checkbox
        value={channel.id}
        data-testid="picker-channel"
        className="group flex min-h-6 pointer-coarse:min-h-11 items-center gap-3 outline-none"
      >
        <Box />
        <span className="flex flex-col">
          <DirText>{channel.nickname ?? channel.display_name}</DirText>
          {channel.handle ? (
            <span className="text-sm text-text-muted">
              <DirText dir="ltr">{channel.handle}</DirText>
            </span>
          ) : null}
        </span>
      </Checkbox>
      <ChannelState channel={channel} />
      {RECONNECTABLE.has(channel.connection_state) ? (
        <Link
          to={`/w/${workspace}/channels/${channel.id}`}
          className="min-h-6 pointer-coarse:leading-11 text-link underline"
        >
          <Trans id="composer.picker.reconnect">Reconnect</Trans>
        </Link>
      ) : null}
    </div>
  );
}

function Group({
  channels,
  provider,
  workspace,
}: {
  channels: Channel[];
  provider: Provider | undefined;
  workspace: string;
}) {
  const words = useWords();
  const name = provider?.display_name ?? channels[0]?.provider_id ?? "";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of boxes inside the one checkbox group
    <div role="group" aria-label={name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-md font-medium">
          <DirText>{name}</DirText>
        </h3>
        <CapabilityChips
          info={{ name, secretKind: null, capabilities: provider?.capabilities ?? [] }}
          words={words}
        />
      </div>
      {channels.map((channel) => (
        <ChannelRow key={channel.id} channel={channel} workspace={workspace} />
      ))}
    </div>
  );
}

function groupsOf(channels: readonly Channel[]): Channel[][] {
  const groups = new Map<string, Channel[]>();
  for (const channel of channels)
    groups.set(channel.provider_id, [...(groups.get(channel.provider_id) ?? []), channel]);
  return [...groups.values()];
}

export function ChannelPicker({
  workspace,
  channels,
  providers,
  selected,
  onChange,
  readOnly,
}: {
  workspace: string;
  channels: readonly Channel[];
  providers: ReadonlyMap<string, Provider>;
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  readOnly: boolean;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  if (channels.length === 0) {
    return (
      <EmptyState
        kind="first-use"
        title={<Trans id="composer.picker.empty.title">No channels yet</Trans>}
        action={{
          label: t({ id: "composer.picker.empty.action", message: "Connect a channel" }),
          onPress: () => void navigate(`/w/${workspace}/channels`),
          testId: "picker-connect",
        }}
      >
        <Trans id="composer.picker.empty.body">Connect a channel to choose where this post goes.</Trans>
      </EmptyState>
    );
  }
  const all = channels.map((channel) => channel.id);
  const everything = all.every((id) => selected.includes(id));
  return (
    <section aria-labelledby="composer-channels" className="flex flex-col gap-3">
      <h2 id="composer-channels" className="font-heading text-xl">
        <Trans id="composer.picker.title">Channels</Trans>
      </h2>
      <Checkbox
        data-testid="picker-all"
        isSelected={everything}
        isIndeterminate={!everything && selected.length > 0}
        isReadOnly={readOnly}
        onChange={(on) => onChange(on ? all : [])}
        className="group flex min-h-6 pointer-coarse:min-h-11 items-center gap-3 outline-none"
      >
        <Box />
        <Trans id="composer.picker.all">Select all</Trans>
      </Checkbox>
      <CheckboxGroup
        aria-labelledby="composer-channels"
        value={[...selected]}
        onChange={onChange}
        isReadOnly={readOnly}
        className="flex flex-col gap-3"
      >
        {groupsOf(channels).map((group) => (
          <Group
            key={group[0]?.provider_id}
            channels={group}
            provider={providers.get(group[0]?.provider_id ?? "")}
            workspace={workspace}
          />
        ))}
      </CheckboxGroup>
    </section>
  );
}
