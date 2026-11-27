import { randomUUID } from "node:crypto";
import { SealedSecret } from "@shoutory/core/crypto";
import { withTenant } from "@shoutory/db/context";
import type { InspectInput, ProviderAdapter, RefreshInput } from "@shoutory/provider-sdk/adapter";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredentialService } from "../../src/channels/credentials.js";
import { createHealthChecker } from "../../src/channels/health.js";
import { ensureProviderApp } from "../../src/channels/provider-app.js";
import { accessOf } from "../../src/jobs/ledger/account.js";
import type { Operation } from "../../src/jobs/ledger/held.js";
import { createLogger } from "../../src/logging/logger.js";
import { seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, keys, PEPPER, startFixture } from "./auth/harness.js";

// A provider that binds each token to a key and names its issuer: the key and the issuer must reach every call that
// opens the token, and a refresh must neither drop nor replace them.
const KEY = { kty: "EC", crv: "P-256", x: "x-2", y: "y-2", d: "dpop-private-2" };
const ISSUER = "https://issuer.example.test";
const manifest = manifestSchema.parse({
  ...fixtureManifest,
  id: "fixture_dpop",
  displayName: "Fixture DPoP",
  egressHosts: ["issuer.example.test"],
  refreshErrorMap: { invalid_grant: "revoked" },
});
const seen: RefreshInput[] = [];
const adapter: ProviderAdapter = {
  prepare: async () => ({ ok: false, effect: "none", errorClass: "permanent" }),
  commit: async () => ({ ok: false, effect: "none", errorClass: "permanent" }),
  readBack: async () => ({ ok: false, effect: "none", errorClass: "permanent" }),
  delete: async () => ({ ok: false, effect: "none", errorClass: "permanent" }),
  inspect: async () => ({ ok: true, effect: "none" }) as ProviderResult,
  connect: {
    appKind: "provider",
    authorize: async () => ({ url: "https://issuer.example.test/" }),
    exchangeCode: async () => ({ ok: false, effect: "none", errorClass: "permanent" }),
    identity: async () => ({ ok: false, effect: "none", errorClass: "permanent" }),
  },
  refresh: async (_context, input) => {
    seen.push(input);
    return {
      ok: true,
      effect: "none",
      credential: {
        accessToken: new SealedSecret("access-after-refresh"),
        expiresInSeconds: 1800,
        dpopPrivateJwk: { ...KEY, d: "a-key-a-refresh-must-not-install" },
      },
    };
  },
};

let fx: Fixture;
let workspace: string;
const service = () =>
  createCredentialService({
    pool: fx.db.pool("worker"),
    keys,
    pepper: new SealedSecret(PEPPER),
    fetch,
    now: () => new Date(),
    logger: createLogger({ secrets: [], stream: { write: () => undefined } }),
    providerTimeoutMs: 400,
    providers: { fixture_dpop: { adapter, manifest } },
  });

async function connected(accountId: string, expiresInMs: number): Promise<string> {
  const made = await service().connect({
    principal: { principalKind: "job", principalId: randomUUID(), workspaceIds: [workspace] },
    workspaceId: workspace,
    identity: {
      providerId: "fixture_dpop",
      accountKind: "profile",
      providerAccountId: accountId,
      displayName: "A",
    },
    tokens: {
      access_token: "access-before",
      refresh_token: "refresh-before",
      dpop_private_jwk: KEY,
      issuer: ISSUER,
    },
    accessExpiresAt: new Date(Date.now() + expiresInMs),
    snapshot: {
      manifestDigest: "d",
      apiVersion: "v1",
      sunsetAt: null,
      capabilities: { text: true },
      limits: {},
    },
    audit: { requestId: "req-dpop", ipHmac: null },
  });
  return made.channelId;
}

beforeAll(async () => {
  fx = await startFixture();
  const owner = await signedUser(fx, "dpop-owner");
  workspace = await seedWorkspace(fx, await seedOrganization(fx, owner.id));
  await withTenant(fx.db.pool("worker"), { principalKind: "job", principalId: randomUUID() }, (tx) =>
    ensureProviderApp(tx, keys, "fixture_dpop", null, {
      clientId: "provider-client-2",
      clientSecret: new SealedSecret("provider-secret-2"),
      redirectUri: "https://app.example.test/api/v1/connect/fixture_dpop/callback",
    }),
  );
});
afterAll(() => fx.close());

describe("the key and issuer a token is bound to", () => {
  it("a refresh is given the key and issuer, keeps them in the stored token and never installs a key from the answer", async () => {
    const channel = await connected(`acct-${randomUUID()}`, -1000);
    seen.length = 0;
    const outcome = await service().refresh(workspace, channel);
    expect(outcome.kind).toBe("refreshed");
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]?.dpopKey?.expose() ?? "null")).toEqual(KEY);
    expect(seen[0]?.issuer).toBe(ISSUER);
    expect(seen[0]?.app?.clientId).toBe("provider-client-2");
    const opened = await service().open(workspace, channel);
    expect(opened.accessToken.expose()).toBe("access-after-refresh");
    expect(JSON.parse(opened.dpopKey?.expose() ?? "null")).toEqual(KEY);
    expect(opened.issuer).toBe(ISSUER);
  });

  it("a channel read is given the key and the provider's account id", async () => {
    const accountId = `acct-${randomUUID()}`;
    const channel = await connected(accountId, 3_600_000);
    const inspected: InspectInput[] = [];
    const watching = {
      manifest,
      adapter: {
        ...adapter,
        inspect: async (_context: unknown, input: InspectInput) => {
          inspected.push(input);
          return { ok: true, effect: "none" } as ProviderResult;
        },
      },
    };
    await createHealthChecker({ credentials: service(), now: () => new Date() }).observe(
      workspace,
      channel,
      watching,
    );
    expect(inspected[0]?.providerAccountId).toBe(accountId);
    expect(JSON.parse(inspected[0]?.dpopKey?.expose() ?? "null")).toEqual(KEY);
  });

  it("the access a worker call gets carries the key and the provider's account id", async () => {
    const accountId = `acct-${randomUUID()}`;
    const channel = await connected(accountId, 3_600_000);
    const operation = { workspace_id: workspace, channel_id: channel } as Operation;
    const access = await accessOf(service(), operation, { providerAccountId: accountId });
    expect(access.kind).toBe("ok");
    if (access.kind !== "ok") return;
    expect(access.account.providerAccountId).toBe(accountId);
    expect(JSON.parse(access.account.dpopKey?.expose() ?? "null")).toEqual(KEY);
    expect(access.account.accessToken.expose()).toBe("access-before");
  });
});
