import { vi } from "vitest";
import { channelPage, channelRow, json } from "./app";
import { type ChannelApi, stubChannelApi } from "./channel-api";

type Answer = Response | Promise<Response>;
interface Call {
  body: unknown;
  headers: Record<string, string>;
}

/** The answers of the posts pages, laid over the channel and shared stubs. */
export interface PostApi extends ChannelApi {
  postList?: (query: URLSearchParams) => Answer;
  postDetail?: () => Answer;
  postVersion?: () => Answer;
  postCreate?: (call: Call) => Answer;
  postDelete?: (call: Call) => Answer;
  unschedule?: (call: Call) => Answer;
  cancel?: (call: Call) => Answer;
  resolve?: (call: Call & { confirmed: boolean }) => Answer;
}

export const POST_WS = "0190a000-0000-7000-8000-0000000000c1";
export const postId = (n: number) => `0190a000-0000-7000-8000-00000000a${String(n).padStart(3, "0")}`;
export const CHANNEL_ONE = "0190a000-0000-7000-8000-0000000000d1";
export const CHANNEL_TWO = "0190a000-0000-7000-8000-0000000000d2";
export const CHANNEL_THREE = "0190a000-0000-7000-8000-0000000000d3";
export const OPERATION = "0190a000-0000-7000-8000-0000000006b1";
export const VERSION = "0190a000-0000-7000-8000-0000000007c1";
export const variantId = (n: number) => `0190a000-0000-7000-8000-00000000e${String(n).padStart(3, "0")}`;

export const channels = () =>
  channelPage(
    [
      channelRow({ id: CHANNEL_ONE, display_name: "Acme Page" }),
      channelRow({ id: CHANNEL_TWO, display_name: "Acme Shop" }),
      channelRow({
        id: CHANNEL_THREE,
        display_name: "Acme Blog",
        connection_state: "needs_reconnect",
        reconnect_deadline: "2026-12-01T00:00:00.000Z",
        actions: ["reconnect"],
      }),
    ],
    null,
    [],
  );

export const listTarget = (change: Record<string, unknown> = {}) => ({
  variant_id: variantId(1),
  channel_id: CHANNEL_ONE,
  schedule_state: "settled",
  due_at: null,
  due_tz: null,
  published_at: "2026-11-27T10:00:00.000Z",
  presence: "present",
  hold_reason: null,
  operation_state: "published",
  ...change,
});

export const listRow = (n: number, change: Record<string, unknown> = {}) => ({
  id: postId(n),
  status: "published",
  author_kind: "user",
  author_id: "u1",
  updated_at: "2026-11-27T10:00:00.000Z",
  current_version_id: VERSION,
  excerpt: `Post number ${n}`,
  targets: [listTarget()],
  published_count: 1,
  target_count: 1,
  ...change,
});

export const operation = (change: Record<string, unknown> = {}) => ({
  id: OPERATION,
  kind: "publish",
  state: "published",
  effect: "confirmed",
  reason_code: null,
  part_index: 0,
  ...change,
});

export const detailTarget = (change: Record<string, unknown> = {}) => ({
  variant_id: variantId(1),
  channel_id: CHANNEL_ONE,
  schedule_state: "settled",
  presence: "present",
  published_at: "2026-11-27T10:00:00.000Z",
  due_at: null,
  due_tz: null,
  settings: { audience: "everyone" },
  hold_reason: null,
  operation: operation(),
  actions: ["duplicate"],
  ...change,
});

export const detail = (targets: unknown[], change: Record<string, unknown> = {}) => ({
  id: postId(1),
  status: "published",
  current_version_id: VERSION,
  author_kind: "user",
  author_id: "u1",
  created_at: "2026-11-26T10:00:00.000Z",
  updated_at: "2026-11-27T10:00:00.000Z",
  variants: (targets as { variant_id: string; channel_id: string }[]).map((target) => ({
    id: target.variant_id,
    channel_id: target.channel_id,
    locale: "en",
    post_type: "text",
    text: "Hello from the post",
    parts: [],
    settings: { audience: "everyone" },
    media: [],
  })),
  targets,
  ...change,
});

export const detailAnswer = (targets: unknown[], change: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ data: detail(targets, change) }), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: `"${VERSION}"` },
  });

const POST_PATH = /^\/api\/v1\/workspaces\/[^/]+\/posts(?:\/([^/]+))?(?:\/(unschedule|versions\/[^/]+))?$/;
const OPERATION_PATH =
  /^\/api\/v1\/workspaces\/[^/]+\/operations\/[^/]+\/(cancel|resolutions(?:\/confirmed)?)$/;

const callOf = (init: RequestInit | undefined): Call => ({
  body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  headers: (init?.headers ?? {}) as Record<string, string>,
});

function postAnswers(api: PostApi, url: URL, init: RequestInit | undefined): Answer | undefined {
  const method = init?.method ?? "GET";
  const [, id, rest] = POST_PATH.exec(url.pathname) ?? [];
  if (!POST_PATH.test(url.pathname)) return undefined;
  if (id === undefined) {
    if (method === "GET")
      return api.postList?.(url.searchParams) ?? json({ data: [], meta: { next_cursor: null } });
    return api.postCreate?.(callOf(init)) ?? json({ data: { id: postId(9), version_id: VERSION } }, 201);
  }
  if (rest === "unschedule") return api.unschedule?.(callOf(init));
  if (rest?.startsWith("versions/")) return api.postVersion?.();
  if (method === "DELETE") return api.postDelete?.(callOf(init));
  return method === "GET" ? api.postDetail?.() : undefined;
}

function operationAnswers(api: PostApi, url: URL, init: RequestInit | undefined): Answer | undefined {
  const [, route] = OPERATION_PATH.exec(url.pathname) ?? [];
  if (route === undefined || init?.method !== "POST") return undefined;
  if (route === "cancel") return api.cancel?.(callOf(init));
  return api.resolve?.({ ...callOf(init), confirmed: route.endsWith("/confirmed") });
}

export function stubPostApi(api: PostApi = {}) {
  stubChannelApi({ channelList: channels, ...api });
  const inner = globalThis.fetch;
  const stub = vi.fn((path: string, init?: RequestInit) => {
    const url = new URL(path, "http://same-origin.invalid");
    const answer = postAnswers(api, url, init) ?? operationAnswers(api, url, init);
    return answer === undefined ? inner(path, init) : Promise.resolve(answer);
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

export const bodyOf = (stub: ReturnType<typeof stubPostApi>, method: string, part: string): unknown => {
  const call = stub.mock.calls.find(
    ([url, init]) => url.includes(part) && (init?.method ?? "GET") === method,
  );
  return typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
};
