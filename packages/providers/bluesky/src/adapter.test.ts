import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { refreshClassOf } from "@shoutory/core/channels";
import { SealedSecret } from "@shoutory/core/crypto";
import type { ExchangeInput, RefreshInput } from "@shoutory/provider-sdk/adapter";
import { EgressError } from "@shoutory/provider-sdk/egress/errors";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN,
  type Arming,
  accountOf,
  appOf,
  CLIENT_ID,
  DID,
  DID_WEB,
  HANDLE,
  ISSUER,
  type Keys,
  makeKeys,
  network,
  PDS,
  proofNonce,
  REFRESH_TOKEN,
  WEB_HOST,
} from "../test/support/network.js";
import { createBlueskyAdapter } from "./adapter.js";
import { blueskyManifest } from "./manifest.js";

const REDIRECT = "https://app.example.test/api/v1/connect/bluesky/callback";

const exchangeInput = (keys: Keys, loginHint: string): ExchangeInput => ({
  code: "authorization-code-1",
  codeVerifier: new SealedSecret("code-verifier-for-bluesky-tests-0123456789abcdef"),
  redirectUri: REDIRECT,
  app: appOf(keys),
  dpopKey: new SealedSecret(JSON.stringify(keys.dpop)),
  issuer: ISSUER,
  loginHint,
});

const refreshInput = (keys: Keys): RefreshInput => ({
  refreshToken: new SealedSecret(REFRESH_TOKEN),
  dpopKey: new SealedSecret(JSON.stringify(keys.dpop)),
  issuer: ISSUER,
  instanceHost: "pds.example",
  app: appOf(keys),
});

interface ExchangeOptions {
  readonly loginHint?: string;
  readonly resolveTxt?: (name: string) => Promise<string[]>;
}

function connectOf() {
  const connect = createBlueskyAdapter().connect;
  if (connect?.authorize === undefined || connect.exchangeCode === undefined) {
    throw new Error("the adapter has no OAuth connect");
  }
  return { authorize: connect.authorize.bind(connect), exchangeCode: connect.exchangeCode.bind(connect) };
}

// The key set the app serves, so the simulator checks every client assertion against it.
const jwksOf = async (keys: Keys) => {
  const documents = await createBlueskyAdapter().connect?.publicDocuments?.({
    publicOrigin: "https://app.example.test",
    app: appOf(keys),
  });
  return documents?.["jwks.json"] as { keys: Record<string, unknown>[] };
};

const exchange = async (arming: Arming, options: ExchangeOptions = {}, keys = makeKeys()) => {
  const net = await network({ ...arming, clientJwks: await jwksOf(keys) });
  const context = { ...net.context, resolveTxt: options.resolveTxt };
  const input = exchangeInput(keys, options.loginHint ?? HANDLE);
  return { answer: await connectOf().exchangeCode(context, input), net, keys };
};

const tokenRequests = (net: Awaited<ReturnType<typeof network>>) =>
  net.seen.filter(({ url }) => url.endsWith("/oauth/token"));

const create = async (arming: Arming, post: { marker?: string; text?: string; replyTo?: string } = {}) => {
  const net = await network(arming);
  const answer = await createBlueskyAdapter().commit(net.context, {
    idempotencyKey: post.marker ?? "operation-marker-1",
    text: post.text ?? "hello from the floor tests",
    account: accountOf(makeKeys()),
    ...(post.replyTo === undefined ? {} : { replyToExternalId: post.replyTo }),
  });
  return { answer, net };
};

const createRequests = (net: Awaited<ReturnType<typeof network>>) =>
  net.seen.filter(({ url }) => url.endsWith("com.atproto.repo.createRecord"));

const formsOf = (secret: string) => [
  secret,
  encodeURIComponent(secret),
  Buffer.from(secret).toString("hex"),
  Buffer.from(secret).toString("base64"),
  Buffer.from(secret).toString("base64url"),
  JSON.stringify(secret).slice(1, -1),
];

const shownOf = (answers: readonly ProviderResult[]) =>
  answers.map((answer) => [inspect(answer, { depth: 8 }), JSON.stringify(answer)].join("\n")).join("\n");

describe("the grant (floor)", () => {
  it("accepts a grant whose sub is the DID the handle resolves to, with the PDS host as the account's server", async () => {
    const { answer, keys } = await exchange({});
    expect(answer.ok).toBe(true);
    expect(JSON.parse(answer.credential?.dpopPrivateJwk?.expose() ?? "{}")).toEqual(keys.dpop);
    expect(answer.identity?.instanceHost).toBe("pds.example");
    expect(answer.identity?.handle).toBe(HANDLE);
  });

  it.each([
    ["a token whose sub is another DID", { sub: "did:plc:someoneelse1234567890abc" }],
    ["a token answer without the atproto scope", { scope: "transition:generic" }],
    ["a handle the DID document does not list back", { claimsHandle: false }],
    [
      "a PDS whose protected-resource metadata names another authorization server",
      { resourceIssuer: "https://other-auth.example" },
    ],
    [
      "a PDS whose protected-resource metadata names another resource",
      { resource: "https://other-pds.example" },
    ],
  ] as const)("refuses %s and hands over no credential", async (_name, arming) => {
    const { answer } = await exchange(arming);
    expect(answer.ok).toBe(false);
    expect(answer.errorClass).toBe("permanent");
    expect(answer.credential).toBeUndefined();
    expect(answer.identity).toBeUndefined();
  });

  it("refuses a did:web whose host the egress policy refuses, before any code exchange", async () => {
    const { answer, net } = await exchange({ sub: DID_WEB, refuseHosts: [WEB_HOST] }, { loginHint: DID_WEB });
    expect(answer.ok).toBe(false);
    expect(answer.errorClass).toBe("permanent");
    expect(answer.providerCode).toBe("address_not_allowed");
    expect(tokenRequests(net)).toHaveLength(0);
  });
});

describe("who the handle or DID is", () => {
  it.each([
    [
      "a DNS TXT record names the DID (the handle has no HTTPS document)",
      { wellKnown: false },
      ["did=%DID%"],
    ],
    ["the TXT record is absent, so the HTTPS document answers", {}, []],
    ["another TXT value is ignored, so the HTTPS document answers", {}, ["v=spf1 -all"]],
  ] as const)("%s", async (_name, arming, records) => {
    const resolveTxt = async () => records.map((record) => record.replace("%DID%", DID));
    const { answer } = await exchange(arming, { resolveTxt });
    expect(answer.ok).toBe(true);
    expect(answer.identity?.providerAccountId).toBe(DID);
  });

  it("asks for the TXT name _atproto.<handle> first", async () => {
    const asked: string[] = [];
    const resolveTxt = async (name: string) => {
      asked.push(name);
      return [`did=${DID}`];
    };
    await exchange({ wellKnown: false }, { resolveTxt });
    expect(asked).toEqual([`_atproto.${HANDLE}`]);
  });

  it("a typed handle whose host does not resolve is a handle nobody has, not a failure of ours", async () => {
    const { answer, net } = await exchange({ dnsFailHosts: [HANDLE] });
    expect(answer).toMatchObject({ ok: false, errorClass: "permanent", providerCode: "handle_unresolved" });
    expect(tokenRequests(net)).toHaveLength(0);
  });

  it.each([
    ["a TXT lookup with no such name falls back to the HTTPS document", "dns", true, undefined],
    ["a TXT lookup that times out is transient", "timeout", false, "retryable_before_send"],
    ["a TXT lookup that cannot connect is transient", "connect", false, "retryable_before_send"],
    ["a TXT lookup the egress policy refuses is not allowed", "blocked_address", false, "permanent"],
  ] as const)("%s", async (_name, egressClass, accepted, errorClass) => {
    const resolveTxt = async () => {
      throw new EgressError({ class: egressClass, host: "" });
    };
    const { answer } = await exchange({}, { resolveTxt });
    expect(answer.ok).toBe(accepted);
    if (errorClass !== undefined) expect(answer.errorClass).toBe(errorClass);
    if (egressClass === "blocked_address") expect(answer.providerCode).toBe("address_not_allowed");
  });

  it("reads a did:web document from the host's /.well-known/did.json", async () => {
    const { answer, net } = await exchange({ sub: DID_WEB }, { loginHint: DID_WEB });
    expect(answer.ok).toBe(true);
    expect(answer.identity?.providerAccountId).toBe(DID_WEB);
    expect(net.seen.map(({ url }) => url)).toContain(`https://${WEB_HOST}/.well-known/did.json`);
  });
});

describe("the DPoP nonce (floor)", () => {
  it("retries the token request once with the nonce the authorization server named", async () => {
    const { answer, net } = await exchange({ nonceChallenges: 1 });
    const [first, second] = tokenRequests(net);
    expect(answer.ok).toBe(true);
    expect(tokenRequests(net)).toHaveLength(2);
    expect(proofNonce(first?.headers ?? {})).toBeUndefined();
    expect(proofNonce(second?.headers ?? {})).toBe("auth-nonce-1");
  });

  it("does not retry the token request a second time when the server asks again", async () => {
    const { answer, net } = await exchange({ nonceChallenges: Number.POSITIVE_INFINITY });
    expect(answer.ok).toBe(false);
    expect(answer.credential).toBeUndefined();
    expect(tokenRequests(net)).toHaveLength(2);
  });

  it("retries a refused create once with the nonce the server named and creates one record", async () => {
    const { answer, net } = await create({ nonceChallenges: 1 });
    expect(answer.ok).toBe(true);
    expect(net.sim.created()).toBe(1);
  });

  it("stops after one retry when the server asks again, with no effect and no third request", async () => {
    const { answer, net } = await create({ nonceChallenges: Number.POSITIVE_INFINITY });
    expect(answer.ok).toBe(false);
    expect(answer.effect).toBe("none");
    expect(net.sim.created()).toBe(0);
    expect(net.seen.filter(({ url }) => url.endsWith("createRecord"))).toHaveLength(2);
  });
});

describe("a lost answer after the record may exist (floor)", () => {
  it.each([
    ["a 500", 500],
    ["a 502", 502],
    ["a connection cut off", "cut"],
  ] as const)(
    "answering %s is an unknown outcome and the create is sent once",
    async (_name, createFails) => {
      const { answer, net } = await create({ createFails, nonces: false });
      expect(answer.ok).toBe(false);
      expect(answer.effect).toBe("possible");
      expect(["unknown", "retryable_after_send"]).toContain(answer.errorClass);
      expect(net.sim.created()).toBe(1);
    },
  );
});

describe("secrets (floor)", () => {
  it("DPoP key, client key and tokens never appear in logs, errors or recorded answers in five forms", async () => {
    const keys = makeKeys();
    const adapter = createBlueskyAdapter();
    const net = await network({ echo: true });
    const refused = await network({ echo: true, refreshStatus: 400, createFails: 500 });
    const granted = await connectOf().exchangeCode(net.context, exchangeInput(keys, HANDLE));
    const refreshed = await adapter.refresh?.(net.context, refreshInput(keys));
    const created = await adapter.commit(net.context, {
      idempotencyKey: "operation-marker-2",
      text: "secrets stay sealed",
      account: accountOf(keys),
    });
    const revoked = await adapter.refresh?.(refused.context, refreshInput(keys));
    const failed = await adapter.commit(refused.context, {
      idempotencyKey: "operation-marker-3",
      text: "secrets stay sealed",
      account: accountOf(keys),
    });
    expect([granted?.ok, refreshed?.ok, created.ok]).toEqual([true, true, true]);
    expect([revoked?.ok, failed.ok]).toEqual([false, false]);

    const answers = [granted, refreshed, created, revoked, failed].filter((one) => one !== undefined);
    const privateParts = [keys.client, keys.dpop].map((key) => String(key.d));
    const tokens = [ACCESS_TOKEN, REFRESH_TOKEN];
    const requests = [...net.seen, ...refused.seen];
    const wire = requests.map((one) => `${one.url}\n${one.body}`).join("\n");
    const urls = requests.map((one) => one.url).join("\n");
    const shown = shownOf(answers);

    for (const secret of [...privateParts, ...tokens]) {
      expect(secret.length).toBeGreaterThanOrEqual(16);
      expect(formsOf(secret).filter((form) => shown.includes(form))).toEqual([]);
    }
    // The refresh token is the one secret a request body carries, as the token endpoint requires; no other goes in a body.
    expect(privateParts.flatMap(formsOf).filter((form) => wire.includes(form))).toEqual([]);
    expect(tokens.flatMap(formsOf).filter((form) => urls.includes(form))).toEqual([]);
    expect(formsOf(ACCESS_TOKEN).filter((form) => wire.includes(form))).toEqual([]);
  });
});

describe("starting a sign-in", () => {
  it("pushes the request with the handle and sends the browser only the request URI", async () => {
    const net = await network({ nonces: false });
    const keys = makeKeys();
    const started = await connectOf().authorize(net.context, {
      state: "state-for-bluesky-tests",
      codeChallenge: "challenge-for-bluesky-tests",
      redirectUri: REDIRECT,
      app: appOf(keys),
      loginHint: HANDLE,
    });
    if (!("url" in started)) throw new Error("the sign-in was refused");
    const url = new URL(started.url);
    expect(url.origin).toBe(ISSUER);
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "request_uri"]);
    expect(started.requestUri).toBe(url.searchParams.get("request_uri"));
    expect(started.issuer).toBe(ISSUER);
    const pushed = new URLSearchParams(net.seen.find(({ url: seen }) => seen.endsWith("/oauth/par"))?.body);
    expect(pushed.get("login_hint")).toBe(HANDLE);
    expect(pushed.get("code_challenge_method")).toBe("S256");
    expect(started.dpopKey).toBeDefined();
  });
});

describe("the name pushed with a sign-in", () => {
  it.each([
    ["a handle typed with a leading @, capitals and spaces", "  @Alice.Example ", HANDLE],
    ["a DID whose handle checks out", DID, HANDLE],
    ["a did:web with no handle", DID_WEB, DID_WEB],
  ])("%s is pushed as the name the account resolved to: %s", async (_name, typed, pushedName) => {
    const net = await network({ nonces: false });
    await connectOf().authorize(net.context, {
      state: "state-for-bluesky-tests",
      codeChallenge: "challenge-for-bluesky-tests",
      redirectUri: REDIRECT,
      app: appOf(makeKeys()),
      loginHint: typed,
    });
    const pushed = net.seen.find(({ url }) => url.endsWith("/oauth/par"));
    expect(new URLSearchParams(pushed?.body).get("login_hint")).toBe(pushedName);
  });
});

describe("a sign-in that cannot start", () => {
  it.each([
    ["a handle that is not a handle", "not a handle", {}, "login_invalid"],
    ["a handle nobody resolves", HANDLE, { wellKnown: false }, "handle_unresolved"],
    ["a handle whose host does not resolve", HANDLE, { dnsFailHosts: [HANDLE] }, "handle_unresolved"],
    [
      "a handle whose document names a did:plc of the wrong length",
      HANDLE,
      { handleDid: "did:plc:tooshort" },
      "handle_unresolved",
    ],
    [
      "an authorization server that cannot take part",
      HANDLE,
      { authServer: "no_s256" },
      "auth_server_unsupported",
    ],
  ] as const)("%s is a failed result with no request pushed", async (_name, loginHint, arming, code) => {
    const net = await network({ nonces: false, ...arming });
    const answer = await connectOf().authorize(net.context, {
      state: "state-for-bluesky-tests",
      codeChallenge: "challenge-for-bluesky-tests",
      redirectUri: REDIRECT,
      app: appOf(makeKeys()),
      loginHint,
    });
    expect(answer).toMatchObject({ ok: false, errorClass: "permanent", providerCode: code });
    expect(net.seen.some(({ url }) => url.endsWith("/oauth/par"))).toBe(false);
  });
});

describe("the client documents", () => {
  it("publishes the client metadata and the public part of the key, never the private part", async () => {
    const keys = makeKeys();
    const documents = await createBlueskyAdapter().connect?.publicDocuments?.({
      publicOrigin: "https://app.example.test",
      app: appOf(keys),
    });
    const metadata = documents?.["client-metadata.json"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      client_id: CLIENT_ID,
      token_endpoint_auth_method: "private_key_jwt",
      dpop_bound_access_tokens: true,
      scope: "atproto transition:generic",
    });
    const [key] = (documents?.["jwks.json"] as { keys: Record<string, unknown>[] } | undefined)?.keys ?? [];
    expect(key).toMatchObject({ kty: "EC", crv: "P-256", x: keys.client.x, y: keys.client.y });
    expect(key).not.toHaveProperty("d");
  });
});

describe("the authorization server is trusted as the PDS names it (floor)", () => {
  const entries = {
    authorize: async (net: Awaited<ReturnType<typeof network>>) =>
      connectOf().authorize(net.context, {
        state: "state-for-bluesky-tests",
        codeChallenge: "challenge-for-bluesky-tests",
        redirectUri: REDIRECT,
        app: appOf(makeKeys()),
        loginHint: HANDLE,
      }),
    refresh: async (net: Awaited<ReturnType<typeof network>>) =>
      createBlueskyAdapter().refresh?.(net.context, refreshInput(makeKeys())),
  };
  const flaws = [
    [
      "metadata whose issuer differs from the one the PDS names",
      { metadataIssuer: "https://other-auth.example" },
    ],
    ["metadata whose token endpoint is not https", { endpoints: "http" }],
  ] as const;

  it.each(
    flaws.flatMap(([flaw, arming]) =>
      (["authorize", "refresh"] as const).map((entry) => [entry, flaw, arming] as const),
    ),
  )("%s refuses %s, sends nothing to the server and is no revoked sign-in", async (entry, _flaw, arming) => {
    const net = await network({ nonces: false, ...arming });
    const answer = await entries[entry](net);
    expect(answer).toMatchObject({
      ok: false,
      errorClass: "permanent",
      providerCode: "auth_server_unsupported",
    });
    expect(net.seen.filter(({ url }) => url.includes("/oauth/"))).toHaveLength(0);
    if (entry === "refresh")
      expect(refreshClassOf(answer as ProviderResult, blueskyManifest.refreshErrorMap)).toBe("config");
  });
});

describe("the grant proves the client and the sign-in it began (floor)", () => {
  const VERIFIER = "code-verifier-for-bluesky-tests-0123456789abcdef";
  const challenge = createHash("sha256").update(VERIFIER).digest("base64url");

  it("a client assertion signed by the app key verifies against the key set the app serves", async () => {
    const { answer } = await exchange({});
    expect(answer.ok).toBe(true);
  });

  it("an assertion signed by a key the app does not serve is refused", async () => {
    const net = await network({ clientJwks: await jwksOf(makeKeys()) });
    const answer = await connectOf().exchangeCode(net.context, exchangeInput(makeKeys(), HANDLE));
    expect(answer.ok).toBe(false);
    expect(answer.credential).toBeUndefined();
  });

  it("the code grant carries the verifier and the redirect address of the request that was pushed", async () => {
    const keys = makeKeys();
    const net = await network({ nonces: false, clientJwks: await jwksOf(keys) });
    const started = await connectOf().authorize(net.context, {
      state: "state-for-bluesky-tests",
      codeChallenge: challenge,
      redirectUri: REDIRECT,
      app: appOf(keys),
      loginHint: HANDLE,
    });
    expect(started).toHaveProperty("url");
    const answer = await connectOf().exchangeCode(net.context, exchangeInput(keys, HANDLE));
    expect(answer.ok).toBe(true);
  });

  it("a verifier that does not match the pushed challenge is refused by the server", async () => {
    const keys = makeKeys();
    const net = await network({ nonces: false, clientJwks: await jwksOf(keys) });
    await connectOf().authorize(net.context, {
      state: "state-for-bluesky-tests",
      codeChallenge: createHash("sha256")
        .update("another verifier entirely, 43 chars or more, ok")
        .digest("base64url"),
      redirectUri: REDIRECT,
      app: appOf(keys),
      loginHint: HANDLE,
    });
    const answer = await connectOf().exchangeCode(net.context, exchangeInput(keys, HANDLE));
    expect(answer).toMatchObject({ ok: false, providerCode: "invalid_grant" });
  });
});

describe("refresh", () => {
  const refresh = async (arming: Arming, cut = false) => {
    const keys = makeKeys();
    const net = await network({ ...arming, clientJwks: await jwksOf(keys) });
    if (cut) net.sim.faults.failNext("POST /oauth/token", { kind: "truncate" });
    const adapter = createBlueskyAdapter();
    return adapter.refresh?.(net.context, refreshInput(keys));
  };

  it("answers a new access token and keeps the key and issuer the channel holds", async () => {
    const answer = await refresh({});
    expect(answer?.ok).toBe(true);
    expect(answer?.credential?.accessToken.expose()).toBe(ACCESS_TOKEN);
    expect(answer?.credential?.refreshToken?.expose()).toBe(REFRESH_TOKEN);
    expect(answer?.credential?.dpopPrivateJwk).toBeUndefined();
  });

  it.each([
    ["a 400 invalid_grant", "revoked", 400, "invalid_grant", false],
    ["a 401 invalid_grant", "revoked", 401, "invalid_grant", false],
    ["a 400 invalid_dpop_proof", "config", 400, "invalid_dpop_proof", false],
    ["a 401 invalid_client", "config", 401, "invalid_client", false],
    ["a bodyless 403", "config", 403, null, false],
    ["a 409", "config", 409, null, false],
    ["a 429", "rate_limited", 429, null, false],
    ["a 500", "transient", 500, null, false],
    ["a 503", "transient", 503, null, false],
    ["an answer cut short", "transient", undefined, null, true],
  ] as const)("%s on refresh is classed %s", async (_name, expected, refreshStatus, refreshError, cut) => {
    const answer = await refresh(
      { ...(refreshStatus === undefined ? {} : { refreshStatus, refreshError }), nonces: false },
      cut,
    );
    expect(answer?.ok).toBe(false);
    expect(refreshClassOf(answer ?? {}, blueskyManifest.refreshErrorMap)).toBe(expected);
  });
});

describe("the account check", () => {
  it("is ok while the token is taken, and a refused token is auth_revoked", async () => {
    const net = await network({ nonces: false });
    const adapter = createBlueskyAdapter();
    const input = {
      accessToken: accountOf(makeKeys()).accessToken,
      instanceHost: PDS,
      providerAccountId: DID,
    };
    const dpopKey = accountOf(makeKeys()).dpopKey;
    const ok = await adapter.inspect(net.context, { ...input, ...(dpopKey ? { dpopKey } : {}) });
    expect([ok.ok, ok.health]).toEqual([true, "ok"]);
    net.sim.faults.failNext("GET /xrpc/com.atproto.server.getSession", {
      kind: "respond",
      status: 401,
      body: { error: "ExpiredToken" },
    });
    const refused = await adapter.inspect(net.context, { ...input, ...(dpopKey ? { dpopKey } : {}) });
    expect([refused.ok, refused.errorClass]).toEqual([false, "auth_revoked"]);
  });
});

const TID = /^[234567abcdefghij][234567a-z]{12}$/;

describe("the record key", () => {
  it("the rkey is a valid TID, equal for one operation marker, different for another", async () => {
    const keyOf = async (marker: string) => {
      const { answer, net } = await create({ nonces: false }, { marker });
      expect(answer.ok).toBe(true);
      return JSON.parse(createRequests(net)[0]?.body ?? "{}").rkey as string;
    };
    const [first, again, other] = [await keyOf("marker-a"), await keyOf("marker-a"), await keyOf("marker-b")];
    expect(first).toMatch(TID);
    expect(again).toBe(first);
    expect(other).toMatch(TID);
    expect(other).not.toBe(first);
  });
});

describe("a mention in a post", () => {
  const post = async (arming: Arming, text: string) => {
    const { answer, net } = await create({ nonces: false, ...arming }, { text });
    return { answer, facets: [...net.sim.records().values()][0]?.value.facets };
  };

  it("whose host does not resolve stays plain text and the post is sent", async () => {
    const { answer, facets } = await post({ dnsFailHosts: ["carol.example"] }, "hello @carol.example");
    expect(answer.ok).toBe(true);
    expect(facets).toBeUndefined();
  });

  it("whose host the egress policy refuses fails the post and creates nothing", async () => {
    const { answer, facets } = await post({ refuseHosts: ["carol.example"] }, "hello @carol.example");
    expect(answer).toMatchObject({ ok: false, errorClass: "permanent", providerCode: "address_not_allowed" });
    expect(facets).toBeUndefined();
  });
});

describe("a stored key that cannot be used", () => {
  const POST_URI = `at://${DID}/app.bsky.feed.post/2222222222222`;
  const media = {
    items: [{ mime: "image/png", size: 3, altText: null }],
    read: async () => ({ bytes: new Uint8Array([1, 2, 3]), altText: null }),
  };

  it.each([
    ["not JSON", "this is not a key"],
    ["JSON that is not a P-256 private key", JSON.stringify({ kty: "RSA", n: "abc", e: "AQAB" })],
  ])(
    "%s is a fixed refusal from every call that signs with it, and nothing is sent",
    async (_name, stored) => {
      const net = await network({ nonces: false });
      const adapter = createBlueskyAdapter();
      const dpopKey = new SealedSecret(stored);
      const account = { ...accountOf(makeKeys()), dpopKey };
      const context = { ...net.context, media };
      const answers = [
        await adapter.commit(context, { idempotencyKey: "key-marker-1", text: "t", account }),
        await adapter.readBack(context, { idempotencyKey: "key-marker-1", account }),
        await adapter.delete(context, { externalId: POST_URI, account }),
        await adapter.prepare(context, { idempotencyKey: "key-marker-1", text: "t", account, mediaIds: [] }),
        await adapter.inspect(context, { ...account, dpopKey }),
      ];
      for (const answer of answers) {
        expect(answer).toMatchObject({ ok: false, errorClass: "permanent", providerCode: "invalid_key" });
      }
      expect(net.seen).toHaveLength(0);
    },
  );
});

describe("a delete answered 404 over a record that may still be there", () => {
  const DELETE = "POST /xrpc/com.atproto.repo.deleteRecord";
  const READ = "GET /xrpc/com.atproto.repo.getRecord";
  const missing = { kind: "respond", status: 404, body: { error: "RecordNotFound" } } as const;

  const deleted = async (readFault?: { kind: "respond"; status: number }) => {
    const net = await network({ nonces: false });
    const adapter = createBlueskyAdapter();
    const account = accountOf(makeKeys());
    const made = await adapter.commit(net.context, { idempotencyKey: "gone-marker-1", text: "t", account });
    net.sim.faults.failNext(DELETE, missing);
    if (readFault) net.sim.faults.failNext(READ, readFault);
    return adapter.delete(net.context, { externalId: made.externalId ?? "", account });
  };

  it("is still_present when the read of the same key finds the record", async () => {
    expect(await deleted()).toMatchObject({
      ok: false,
      effect: "possible",
      errorClass: "unknown",
      providerCode: "still_present",
    });
  });

  it("is unknown when the read cannot say", async () => {
    const answer = await deleted({ kind: "respond", status: 500 });
    expect(answer).toMatchObject({ ok: false, effect: "possible", errorClass: "unknown" });
    expect(answer.providerCode).toBeUndefined();
  });
});

describe("a reply to a post that is not the account's own", () => {
  it("is refused before anything is sent", async () => {
    const { answer, net } = await create(
      { nonces: false },
      {
        marker: "reply-marker-1",
        text: "t",
        replyTo: "at://did:plc:bobbobbobbobbobbobbobbob/app.bsky.feed.post/2222222222222",
      },
    );
    expect(answer).toMatchObject({ ok: false, errorClass: "permanent", providerCode: "invalid_input" });
    expect(net.seen).toHaveLength(0);
  });
});

describe("an image whose bytes are larger than its stated size", () => {
  it("is refused before the upload, by the bytes that were read", async () => {
    const net = await network({ nonces: false });
    const media = {
      items: [{ mime: "image/png", size: 10, altText: null }],
      read: async () => ({ bytes: new Uint8Array(2_000_001), altText: null }),
    };
    const answer = await createBlueskyAdapter().prepare(
      { ...net.context, media },
      { idempotencyKey: "big-marker-1", text: "t", account: accountOf(makeKeys()), mediaIds: [] },
    );
    expect(answer).toMatchObject({ ok: false, errorClass: "permanent", providerCode: "invalid_input" });
    expect(net.seen.some(({ url }) => url.endsWith("uploadBlob"))).toBe(false);
  });
});

describe("the text limits", () => {
  it.each([
    ["130 joined emoji, 3250 bytes in 130 graphemes", "👨‍👩‍👧‍👦".repeat(130)],
    ["150 Arabic letters with ten marks each, 3300 bytes in 150 graphemes", `ب${"ً".repeat(10)}`.repeat(150)],
    ["301 plain graphemes", "a".repeat(301)],
  ])("text over a limit is refused before anything is sent: %s", async (_name, text) => {
    const { answer, net } = await create({ nonces: false }, { text });
    expect(answer.ok).toBe(false);
    expect(answer.errorClass).toBe("permanent");
    expect(answer.providerCode).toBe("text_too_long");
    expect(createRequests(net)).toHaveLength(0);
  });

  it("text of exactly 300 graphemes is sent", async () => {
    const { answer } = await create({ nonces: false }, { text: "a".repeat(300) });
    expect(answer.ok).toBe(true);
  });
});
