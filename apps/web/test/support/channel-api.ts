import { vi } from "vitest";
import { type Api, CONNECT_WS, channelRow, json, PROVIDERS, stubApi } from "./app";

type Answer = () => Response | Promise<Response>;

/** The answers of the channel pages beyond the hub list, laid over the shared stub. */
export interface ChannelApi extends Api {
  rename?: (body: unknown) => Response | Promise<Response>;
  move?: (move: string) => Response | Promise<Response>;
  impact?: Answer;
  disconnect?: (headers: Record<string, string>) => Response | Promise<Response>;
  notices?: (query: URLSearchParams) => Response | Promise<Response>;
}

const CHANNEL_PATH = /^\/api\/v1\/workspaces\/[^/]+\/channels\/[^/]+(?:\/(disable|enable|disconnect))?$/;

function overlay(api: ChannelApi, path: string, init: RequestInit | undefined) {
  const url = new URL(path, "http://same-origin.invalid");
  const method = init?.method ?? "GET";
  const [, move] = CHANNEL_PATH.exec(url.pathname) ?? [];
  if (method === "PATCH" && CHANNEL_PATH.test(url.pathname) && move === undefined) {
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return api.rename?.(body);
  }
  if (method === "POST" && (move === "disable" || move === "enable")) return api.move?.(move);
  if (method === "POST" && move === "disconnect") {
    return api.disconnect?.(init?.headers as Record<string, string>);
  }
  if (method === "GET" && url.pathname.endsWith("/disconnect-impact")) return api.impact?.();
  if (method === "GET" && url.pathname.endsWith("/notifications")) return api.notices?.(url.searchParams);
  return undefined;
}

export function stubChannelApi(api: ChannelApi = {}) {
  const base = stubApi(api);
  const stub = vi.fn((path: string, init?: RequestInit) => {
    const answer = overlay(api, path, init);
    return answer === undefined ? base(path, init) : Promise.resolve(answer);
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

export const providersWith =
  (...change: Record<string, unknown>[]) =>
  () =>
    json({ data: change.map((one, n) => ({ ...PROVIDERS[0], ...one, id: one.id ?? `fixture_${n}` })) });

export const WS = CONNECT_WS;
export const CHANNEL = channelRow().id;
export const detailPath = (id = CHANNEL) => `/w/${WS}/channels/${id}`;
