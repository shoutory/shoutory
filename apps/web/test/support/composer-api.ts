import { act } from "react";
import { vi } from "vitest";
import { channelPage, channelRow, json } from "./app";
import { type ChannelApi, stubChannelApi } from "./channel-api";

export interface Call {
  method: string;
  /** The path after the workspace, such as `posts/<id>/schedule`. */
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

type Answer = Response | Promise<Response> | undefined;

/** The composer's calls are answered by one function that looks at the method and the path. */
export interface ComposerApi extends ChannelApi {
  answer?: (call: Call) => Answer;
}

export const WS = "w1";
export const POST = "0190a000-0000-7000-8000-00000000a001";
export const VERSION_1 = "0190a000-0000-7000-8000-0000000007c1";
export const VERSION_2 = "0190a000-0000-7000-8000-0000000007c2";
export const VERSION_3 = "0190a000-0000-7000-8000-0000000007c3";
export const CH = {
  short: "0190a000-0000-7000-8000-0000000000d1",
  bytes: "0190a000-0000-7000-8000-0000000000d2",
  weighted: "0190a000-0000-7000-8000-0000000000d3",
  thread: "0190a000-0000-7000-8000-0000000000d4",
  broken: "0190a000-0000-7000-8000-0000000000d5",
} as const;

const provider = (id: string, name: string, change: Record<string, unknown>) => ({
  id,
  display_name: name,
  lifecycle: "ga",
  auth_kind: "oauth2_pkce",
  connectable: true,
  needs_instance_host: false,
  needs_login_hint: false,
  needs_public_origin: false,
  secret_kind: null,
  capabilities: ["text", "image"],
  counting: { unit: "graphemes" },
  limits: {},
  follow_up_roles: [],
  ...change,
});

export const PROVIDER_LIST = [
  provider("short_net", "Short Net", { limits: { text_length: 20, media_max_count: 2 } }),
  provider("bytes_net", "Bytes Net", { limits: { text_bytes: 30 } }),
  provider("weighted_net", "Weighted Net", {
    counting: {
      unit: "weighted",
      urlWeight: 23,
      weights: { defaultWeight: 1, ranges: [{ from: 1536, to: 1791, weight: 2 }] },
    },
    limits: { text_length: 10 },
  }),
  provider("thread_net", "Thread Net", {
    capabilities: ["text", "image", "video", "thread", "first_comment"],
    limits: { text_length: 280, media_max_count: 4 },
    follow_up_roles: ["thread_reply", "first_comment"],
  }),
];

const named = (id: string, provider_id: string, display_name: string, change = {}) =>
  channelRow({ id, provider_id, display_name, handle: null, actions: [], ...change });

export const CHANNELS = [
  named(CH.short, "short_net", "Short One"),
  named(CH.bytes, "bytes_net", "Bytes One"),
  named(CH.weighted, "weighted_net", "Weighted One"),
  named(CH.thread, "thread_net", "Thread One"),
];

export const BROKEN = named(CH.broken, "short_net", "Short Broken", {
  connection_state: "needs_reconnect",
});

export const variantRow = (channel: string, text: string, change: Record<string, unknown> = {}) => ({
  channel_id: channel,
  locale: null,
  post_type: "text",
  text,
  parts: [],
  settings: {},
  media: [],
  ...change,
});

/** The post as the server's detail answer gives it: one target for each variant, with what it may do. */
export const detailOf = (
  variants: ReturnType<typeof variantRow>[],
  actions: string[] = ["schedule", "publish_now", "duplicate"],
  change: Record<string, unknown> = {},
  version = VERSION_1,
) =>
  json({
    data: {
      id: POST,
      status: "draft",
      current_version_id: version,
      variants,
      targets: variants.map((variant, at) => ({
        variant_id: `0190a000-0000-7000-8000-00000000e00${at + 1}`,
        channel_id: variant.channel_id,
        schedule_state: "draft",
        published_at: null,
        due_at: null,
        due_tz: null,
        hold_reason: null,
        actions,
        ...change,
      })),
    },
  });

const callOf = (path: string, url: URL, init: RequestInit | undefined): Call => ({
  method: init?.method ?? "GET",
  path,
  query: url.searchParams,
  body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  headers: (init?.headers ?? {}) as Record<string, string>,
});

export function stubComposerApi(api: ComposerApi = {}) {
  stubChannelApi({
    channelList: () => channelPage(CHANNELS, null, []),
    providers: () => json({ data: PROVIDER_LIST }),
    ...api,
  });
  const inner = globalThis.fetch;
  const stub = vi.fn((path: string, init?: RequestInit) => {
    const url = new URL(path, "http://same-origin.invalid");
    const [, rest] = new RegExp(`^/api/v1/workspaces/${WS}/(.*)$`).exec(url.pathname) ?? [];
    const answer = rest === undefined ? undefined : api.answer?.(callOf(rest, url, init));
    return answer === undefined ? inner(path, init) : Promise.resolve(answer);
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

export const callsOf = (stub: ReturnType<typeof stubComposerApi>, method: string, part: string) =>
  stub.mock.calls
    .filter(([url, init]) => url.includes(part) && (init?.method ?? "GET") === method)
    .map(([, init]) => ({
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }));

/** Types into a text area the way a person does, so React sees the change. */
export function typeInto(field: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set;
  act(() => {
    field.focus();
    setter?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export const field = (id: string) =>
  document.querySelector<HTMLTextAreaElement>(`[data-testid="${id}"]`) as HTMLTextAreaElement;
export const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
export const allById = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
