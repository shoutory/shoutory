import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, requestPages } from "../../http/client";
import { type ProviderInfo, useProviderNames } from "../channels/channel-facts";

const channelsSchema = z.array(
  z.object({
    id: z.string(),
    provider_id: z.string(),
    display_name: z.string(),
    reconnect_deadline: z.string().nullable().default(null),
    actions: z.array(z.string()).default([]),
  }),
);
type ChannelRow = z.infer<typeof channelsSchema>[number];

export interface Names {
  channel: string;
  provider: string;
  /** The channel's own facts, when the channel list holds it. */
  row: ChannelRow | undefined;
}

// A failed read never fails the page: a channel then shows by a plain word, never by its id.
function useChannelRows(ws: string): ReadonlyMap<string, ChannelRow> {
  const [rows, setRows] = useState<ReadonlyMap<string, ChannelRow>>(new Map());
  useEffect(() => {
    let live = true;
    requestPages(channelsSchema, `/api/v1/workspaces/${ws}/channels`).then(
      (found) => live && setRows(new Map(found.map((one) => [one.id, one]))),
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
      },
    );
    return () => {
      live = false;
    };
  }, [ws]);
  return rows;
}

/** Names the channel and the platform of a target from the workspace's channel and provider lists. */
export function useNames(ws: string): (channelId: string) => Names {
  const { t } = useLingui();
  const channels = useChannelRows(ws);
  const providers: ReadonlyMap<string, ProviderInfo> = useProviderNames(ws);
  const aChannel = t({ id: "posts.a_channel", message: "a channel" });
  const aPlatform = t({ id: "posts.the_platform", message: "the platform" });
  return (channelId) => {
    const row = channels.get(channelId);
    return {
      channel: row?.display_name ?? aChannel,
      provider: (row && providers.get(row.provider_id)?.name) ?? aPlatform,
      row,
    };
  };
}
