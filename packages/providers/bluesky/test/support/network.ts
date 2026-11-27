import { generateKeyPairSync } from "node:crypto";
import { SealedSecret } from "@shoutory/core/crypto";
import type { AccountAccess, AdapterContext } from "@shoutory/provider-sdk/adapter";
import { afterEach } from "vitest";
import {
  type BlueskySimulator,
  type SimulatorSettings,
  startBlueskySimulator,
  WORLD,
} from "../../src/simulator.js";

export const { did: DID, handle: HANDLE, didWeb: DID_WEB, pdsHost: PDS, issuer: ISSUER } = WORLD;
export const WEB_HOST = "bob.example";
// One fixed clock for the adapter and the simulator, so proofs and dates agree to the second.
const NOW = new Date("2026-11-27T00:00:00Z");
export const CLIENT_ID = "https://app.example.test/api/v1/provider-documents/bluesky/client-metadata.json";
export const ACCESS_TOKEN = "bluesky-access-token-canary-1";
export const REFRESH_TOKEN = "bluesky-refresh-token-canary-1";

// Fresh P-256 keys at run time, so no key value is ever written in a file.
export const privateJwk = (): Record<string, unknown> => ({
  ...generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }),
  alg: "ES256",
});

export interface Arming extends SimulatorSettings {
  /** What createRecord answers after it created the record: a status, or a connection cut off. */
  readonly createFails?: number | "cut";
  /** Hosts the egress policy refuses: a request to one fails before anything is sent. */
  readonly refuseHosts?: readonly string[];
  /** Hosts that do not resolve: a request to one fails at DNS before anything is sent. */
  readonly dnsFailHosts?: readonly string[];
}

// The failure the adapter's fetch gives for an address the egress client turned away, with the class riding along.
const turnedAway = (egress: string) =>
  Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED", egress } }));

export interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const proofNonce = (headers: Readonly<Record<string, string>>): string | undefined => {
  const payload = headers.dpop?.split(".")[1];
  if (payload === undefined) return undefined;
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  return typeof claims === "object" && claims !== null && "nonce" in claims
    ? String(claims.nonce)
    : undefined;
};

const open: BlueskySimulator[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((one) => one.close()));
});

// Every request goes to one simulator whatever host it asked for, and is recorded under the host it asked for.
export async function network(arming: Arming = {}) {
  const { createFails, refuseHosts, dnsFailHosts, ...settings } = arming;
  const sim = await startBlueskySimulator({ ...settings, now: () => NOW });
  open.push(sim);
  if (createFails === "cut") sim.arm("commit", { kind: "truncate" });
  else if (createFails !== undefined)
    sim.arm("commit", { kind: "respond", status: createFails, afterEffect: true });
  const seen: Seen[] = [];
  const send: typeof fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (refuseHosts?.includes(target.hostname)) return turnedAway("blocked_address");
    if (dnsFailHosts?.includes(target.hostname)) return turnedAway("dns");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body =
      init?.body === undefined || init.body === null
        ? ""
        : Buffer.from(init.body as Uint8Array | string).toString("utf8");
    seen.push({ url: target.href, method: init?.method ?? "GET", headers, body });
    return fetch(new URL(`${target.pathname}${target.search}`, sim.url), init);
  };
  const context: AdapterContext = { fetch: send, now: () => NOW };
  return { seen, context, sim };
}

export interface Keys {
  readonly client: Record<string, unknown>;
  readonly dpop: Record<string, unknown>;
}

export const makeKeys = (): Keys => ({ client: privateJwk(), dpop: privateJwk() });

export const appOf = ({ client }: Keys) => ({
  clientId: CLIENT_ID,
  clientSecret: new SealedSecret(JSON.stringify(client)),
});

export const accountOf = ({ dpop }: Keys): AccountAccess => ({
  accessToken: new SealedSecret(ACCESS_TOKEN),
  instanceHost: PDS,
  providerAccountId: DID,
  dpopKey: new SealedSecret(JSON.stringify(dpop)),
});
