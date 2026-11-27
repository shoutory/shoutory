import { SealedSecret } from "@shoutory/core/crypto";
import type { AdapterContext } from "@shoutory/provider-sdk/adapter";

export const WEBHOOK_ID = "123456789012345678";
export const WEBHOOK_TOKEN = "webhook-token-canary-1";
export const WEBHOOK_URL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;
export const MESSAGE_ID = "223456789012345678";

export const accountOf = (url: string = WEBHOOK_URL) => ({ accessToken: new SealedSecret(url) });

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly userAgent: string | null;
  readonly contentType: string | null;
  readonly body: string | Uint8Array | undefined;
}

export type Scripted = Response | Error;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// Sends every request to the simulator whatever host it asked for.
export function recorder(sim: { readonly url: string }) {
  const send: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return fetch(new URL(`${url.pathname}${url.search}`, sim.url), init);
  };
  const context: AdapterContext = { fetch: send, now: () => new Date("2026-11-27T00:00:00Z") };
  return { context };
}

// Answers each request with the next scripted reply (an Error is a failed connection) and records what was asked.
export function scripted(replies: readonly Scripted[]) {
  const seen: Seen[] = [];
  const queue = [...replies];
  const send: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push({
      method: init?.method ?? "GET",
      url,
      userAgent: new Headers(init?.headers).get("user-agent"),
      contentType: new Headers(init?.headers).get("content-type"),
      body: init?.body as string | Uint8Array | undefined,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error("a request was made that no reply was scripted for");
    if (next instanceof Error) throw next;
    return next;
  };
  const context: AdapterContext = { fetch: send, now: () => new Date("2026-11-27T00:00:00Z") };
  return { seen, context };
}
