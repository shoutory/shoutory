import { SealedSecret } from "@shoutory/core/crypto";
import type { AdapterContext } from "@shoutory/provider-sdk/adapter";

// The instance a channel stored is the simulator: this fetch sends every request to it, whatever host the adapter asked
// for, and records the host and the token each request carried, so a test can say which instance a call was meant for.
export const HOST = "social.example";

export interface Seen {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

export function recorder(sim: { readonly url: string }) {
  const seen: Seen[] = [];
  const send: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push({
      host: url.host,
      method: init?.method ?? "GET",
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return fetch(new URL(`${url.pathname}${url.search}`, sim.url), init);
  };
  const context: AdapterContext = { fetch: send, now: () => new Date("2026-11-24T00:00:00Z") };
  return { seen, context };
}

/** What a worker hands an adapter besides the post: the channel's own token, sealed, and its stored instance host. */
export const accountOf = (token: string, instanceHost: string = HOST) => ({
  accessToken: new SealedSecret(token),
  instanceHost,
});
