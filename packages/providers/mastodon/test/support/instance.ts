import { SealedSecret } from "@shoutory/core/crypto";
import type { AdapterContext } from "@shoutory/provider-sdk/adapter";

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

export const accountOf = (token: string, instanceHost: string = HOST) => ({
  accessToken: new SealedSecret(token),
  instanceHost,
});
