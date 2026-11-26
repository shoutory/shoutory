import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, request } from "undici";
import { EgressError, wrapNetworkError } from "./errors.js";
import { checkUrl, type OperatorPolicy, type RequestPolicy } from "./policy.js";

export interface EgressPolicy {
  readonly request: RequestPolicy;
  readonly operator: OperatorPolicy;
}

export interface EgressRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly connectTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface EgressResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Uint8Array;
}

const MAX_REDIRECTS = 3;
const DEFAULT_CONNECT_MS = 5_000;
const DEFAULT_TOTAL_MS = 15_000;
// The connect timer ends this far before the total one, so a lookup that hangs is a connect timeout (nothing sent).
const CONNECT_MARGIN_MS = 1_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
// The only caller headers a hop to another origin carries; everything else (credentials, API keys) stays with the first.
// The URL and the body decide these, so a caller's value is never sent.
const FRAMING_HEADERS = new Set(["host", "content-length", "transfer-encoding"]);
const SAFE_CROSS_ORIGIN_HEADERS = new Set(["accept", "accept-language", "user-agent"]);

// The socket gets only checked addresses and the whole answer is refused when any address is refused, so a later DNS
// change cannot redirect the connection.
function pinnedLookup(operator: OperatorPolicy): LookupFunction {
  return (hostname: string, options: LookupOptions, callback) => {
    operator.lookup(hostname).then(
      (answers) => {
        const first = answers[0];
        if (first === undefined || answers.some((answer) => !operator.allows(answer.address))) {
          callback(
            new EgressError({ class: "blocked_address", host: hostname }) as NodeJS.ErrnoException,
            "",
            4,
          );
          return;
        }
        if (options.all)
          callback(
            null,
            answers.map(({ address, family }): LookupAddress => ({ address, family })),
          );
        else callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, "", 4),
    );
  };
}

// One pool per operator policy and connect timeout, so keep-alive reuses a connection per host.
const agents = new WeakMap<OperatorPolicy, Map<number, Agent>>();

function agentFor(operator: OperatorPolicy, connectTimeoutMs: number): Agent {
  const byTimeout = agents.get(operator) ?? new Map<number, Agent>();
  agents.set(operator, byTimeout);
  let agent = byTimeout.get(connectTimeoutMs);
  if (agent === undefined) {
    agent = new Agent({
      connect: { lookup: pinnedLookup(operator), timeout: connectTimeoutMs, autoSelectFamily: true },
    });
    byTimeout.set(connectTimeoutMs, agent);
  }
  return agent;
}

/** Closes the pools opened for one operator policy; the policy stays usable and opens new ones. */
export async function closeEgress(operator: OperatorPolicy): Promise<void> {
  const pools = agents.get(operator);
  agents.delete(operator);
  await Promise.all([...(pools?.values() ?? [])].map((agent) => agent.close()));
}

export interface Hop {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array | undefined;
}

async function readCapped(
  stream: AsyncIterable<Uint8Array> & { destroy(): unknown },
  limit: number,
  oversize: () => EgressError,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      stream.destroy();
      throw oversize();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

interface Timing {
  readonly connectMs: number;
  readonly retryBefore: number;
}

async function sendHop(
  hop: Hop,
  policy: EgressPolicy,
  req: EgressRequest,
  signal: AbortSignal,
  connectMs: number,
): Promise<EgressResponse> {
  const host = hop.url.hostname;
  const limit = req.maxBytes ?? DEFAULT_MAX_BYTES;
  const dispatcher = agentFor(policy.operator, connectMs);
  const response = await request(hop.url.href, {
    dispatcher,
    method: hop.method as "GET",
    headers: { ...hop.headers },
    body: hop.body ?? null,
    signal,
  });
  const oversize = () =>
    new EgressError({ class: "size_exceeded", host, status: response.statusCode, effect: "possible" });
  // A HEAD, 204 or 304 answer states the length of a body it does not send, so its header is not a size.
  const hasBody = hop.method !== "HEAD" && ![204, 304].includes(response.statusCode);
  if (hasBody && Number(response.headers["content-length"]) > limit) {
    response.body.destroy();
    throw oversize();
  }
  const body = await readCapped(response.body, limit, oversize);
  return { status: response.statusCode, headers: response.headers, body };
}

/** One hop; a connect timeout happens before anything is sent, so it is retried once while the total time allows. */
async function attempt(
  hop: Hop,
  policy: EgressPolicy,
  req: EgressRequest,
  signal: AbortSignal,
  timing: Timing,
): Promise<EgressResponse> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await sendHop(hop, policy, req, signal, timing.connectMs);
    } catch (error) {
      const wrapped = wrapNetworkError(error, hop.url.hostname);
      const fits = Date.now() + timing.connectMs <= timing.retryBefore;
      if (wrapped.class !== "connect_timeout" || tries >= 2 || !fits) throw wrapped;
    }
  }
}

// A hop to another origin carries only the safe headers and never a body (a 307 or 308 that would carry one is
// refused); a hop that drops the body drops its content headers; `host` is never forwarded.
export function nextHop(hop: Hop, response: EgressResponse): Hop | undefined {
  const location = response.headers.location;
  if (![301, 302, 303, 307, 308].includes(response.status) || typeof location !== "string") return undefined;
  if (!URL.canParse(location, hop.url))
    throw new EgressError({ class: "invalid_url", host: hop.url.hostname });
  const url = new URL(location, hop.url);
  const crossOrigin = url.origin !== hop.url.origin;
  const keepsMethod =
    response.status === 307 || response.status === 308 || ["GET", "HEAD"].includes(hop.method);
  const body = keepsMethod ? hop.body : undefined;
  if (crossOrigin && body !== undefined)
    throw new EgressError({ class: "redirect_refused", host: url.hostname });
  const keeps = (name: string) => {
    const lower = name.toLowerCase();
    if (lower === "host" || (crossOrigin && !SAFE_CROSS_ORIGIN_HEADERS.has(lower))) return false;
    return body !== undefined || !(lower.startsWith("content-") || lower === "transfer-encoding");
  };
  const headers = Object.fromEntries(Object.entries(hop.headers).filter(([name]) => keeps(name)));
  return { url, headers, method: keepsMethod ? hop.method : "GET", body };
}

// A failure is always an `EgressError` with no part of the original error.
export async function egressFetch(req: EgressRequest, policy: EgressPolicy): Promise<EgressResponse> {
  let hop: Hop = {
    url: checkUrl(req.url, policy.request, policy.operator),
    method: req.method ?? "GET",
    headers: Object.fromEntries(
      Object.entries(req.headers ?? {}).filter(([name]) => !FRAMING_HEADERS.has(name.toLowerCase())),
    ),
    body: req.body,
  };
  if (req.signal?.aborted) throw new EgressError({ class: "network", host: hop.url.hostname });
  const totalMs = req.timeoutMs ?? DEFAULT_TOTAL_MS;
  const timing: Timing = {
    connectMs: Math.min(
      req.connectTimeoutMs ?? DEFAULT_CONNECT_MS,
      Math.max(totalMs - CONNECT_MARGIN_MS, totalMs / 2),
    ),
    retryBefore: Date.now() + totalMs - CONNECT_MARGIN_MS,
  };
  const timeout = AbortSignal.timeout(totalMs);
  const signal = req.signal === undefined ? timeout : AbortSignal.any([timeout, req.signal]);
  for (let redirects = 0; ; redirects += 1) {
    const response = await attempt(hop, policy, req, signal, timing);
    const next = nextHop(hop, response);
    if (next === undefined) return response;
    if (redirects >= MAX_REDIRECTS)
      throw new EgressError({ class: "too_many_redirects", host: hop.url.hostname });
    checkUrl(next.url.href, policy.request, policy.operator);
    hop = next;
  }
}
