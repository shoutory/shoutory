import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, request } from "../../http/client";
import { LocalizedDateTime } from "../../ui/localized";

export const channelSchema = z.object({
  id: z.uuid(),
  provider_id: z.string(),
  display_name: z.string(),
  nickname: z.string().nullable(),
  handle: z.string().nullable(),
  connection_state: z.string(),
  health: z.string().nullable(),
  health_checked_at: z.string().nullable(),
  token_expires_at: z.string().nullable().default(null),
  disconnected_at: z.string().nullable().default(null),
  reconnect_deadline: z.string().nullable(),
  actions: z.array(z.string()),
});
export type Channel = z.infer<typeof channelSchema>;

export const dateOf = (value: string | null): Date | null => {
  const date = value === null ? null : new Date(value);
  return date === null || Number.isNaN(date.getTime()) ? null : date;
};
export const RECONNECTABLE = new Set(["needs_reconnect", "disconnected", "revoked_by_provider"]);

const providersSchema = z.array(
  z.object({
    id: z.string(),
    display_name: z.string(),
    secret_kind: z.enum(["bot_token", "webhook_url"]).nullable().default(null),
    capabilities: z.array(z.string()).default([]),
  }),
);
export interface ProviderInfo {
  readonly name: string;
  readonly secretKind: "bot_token" | "webhook_url" | null;
  readonly capabilities: readonly string[];
}

// A failed read never fails the page: the platform shows by its id and no chips.
export function useProviderNames(ws: string): ReadonlyMap<string, ProviderInfo> {
  const [names, setNames] = useState<ReadonlyMap<string, ProviderInfo>>(new Map());
  useEffect(() => {
    let live = true;
    request(providersSchema, `/api/v1/workspaces/${ws}/providers`).then(
      (providers) =>
        live &&
        setNames(
          new Map(
            providers.map((one) => [
              one.id,
              { name: one.display_name, secretKind: one.secret_kind, capabilities: one.capabilities },
            ]),
          ),
        ),
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
      },
    );
    return () => {
      live = false;
    };
  }, [ws]);
  return names;
}

// A value the page does not know gets the unknown word, never Connected.
export function useWords() {
  const { t } = useLingui();
  return {
    state: new Map([
      ["connected", t({ id: "channels.hub.state.connected", message: "Connected" })],
      ["needs_reconnect", t({ id: "connect.result.state.needs_reconnect", message: "Reconnect needed" })],
      ["disconnected", t({ id: "connect.result.state.disconnected", message: "Disconnected" })],
      [
        "revoked_by_provider",
        t({ id: "connect.result.state.revoked_by_provider", message: "Access removed" }),
      ],
      ["disabled", t({ id: "connect.result.state.disabled", message: "Turned off" })],
    ]),
    unknownState: t({ id: "connect.result.state.unknown", message: "Unknown" }),
    health: new Map([
      ["ok", t({ id: "channels.hub.health.ok", message: "Healthy" })],
      ["degraded", t({ id: "channels.hub.health.degraded", message: "Slow or limited" })],
      ["failing", t({ id: "channels.hub.health.failing", message: "Failing" })],
      ["unknown", t({ id: "channels.hub.health.unknown", message: "Not checked yet" })],
    ]),
    capability: new Map([
      ["text", t({ id: "channels.capability.text", message: "Text" })],
      ["image", t({ id: "channels.capability.image", message: "Images" })],
      ["video", t({ id: "channels.capability.video", message: "Video" })],
      ["link_card", t({ id: "channels.capability.link_card", message: "Link cards" })],
      ["thread", t({ id: "channels.capability.thread", message: "Threads" })],
      ["first_comment", t({ id: "channels.capability.first_comment", message: "First comment" })],
      ["edit", t({ id: "channels.capability.edit", message: "Edit after posting" })],
      ["delete", t({ id: "channels.capability.delete", message: "Delete after posting" })],
      ["refresh", t({ id: "channels.capability.refresh", message: "Renews its own access" })],
    ]),
  };
}
export type Words = ReturnType<typeof useWords>;

// A capability the page has no word for is not shown: a raw id is never a label.
export function CapabilityChips({ info, words }: { info: ProviderInfo | undefined; words: Words }) {
  const shown = (info?.capabilities ?? []).flatMap((one) => words.capability.get(one) ?? []);
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {shown.map((word) => (
        <li
          key={word}
          data-testid="card-capability"
          className="rounded-full border border-border px-3 text-sm text-text-muted"
        >
          {word}
        </li>
      ))}
    </ul>
  );
}

// The end of an access that cannot renew itself; only a connected channel has one, and nothing here promises a refresh.
export function ExpiryHint({ row, zone }: { row: Channel; zone: string }) {
  const ends = row.connection_state === "connected" ? dateOf(row.token_expires_at) : null;
  if (ends === null) return null;
  return (
    <span data-testid="card-expiry" className="text-sm">
      <Trans id="channels.expiry">
        Access ends <LocalizedDateTime value={ends} timeZone={zone} />
      </Trans>
    </span>
  );
}
