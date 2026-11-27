import { randomUUID } from "node:crypto";
import { SealedSecret } from "@shoutory/core/crypto";
import { withTenant } from "@shoutory/db/context";
import type { ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureProviderApp } from "../../src/channels/provider-app.js";
import { type Fixture, keys, PEPPER, startFixture } from "./auth/harness.js";

const PRIVATE = "private-key-material-canary-1";
const permanent: ProviderResult = { ok: false, effect: "none", errorClass: "permanent" };
const manifestOf = (id: string) =>
  manifestSchema.parse({ ...fixtureManifest, id, displayName: id, egressHosts: ["docs.example.test"] });
const adapterOf = (connect?: ProviderAdapter["connect"]): ProviderAdapter => ({
  prepare: async () => permanent,
  commit: async () => permanent,
  readBack: async () => permanent,
  delete: async () => permanent,
  inspect: async () => permanent,
  ...(connect === undefined ? {} : { connect }),
});
const connectWith = (documents: Record<string, unknown>): ProviderAdapter["connect"] => ({
  authorize: async () => ({ url: "https://issuer.example.test/" }),
  exchangeCode: async () => permanent,
  identity: async () => permanent,
  publicDocuments: async () => documents,
});

let derived = 0;
const withApp: ProviderAdapter["connect"] = {
  appKind: "provider",
  authorize: async () => ({ url: "https://issuer.example.test/" }),
  exchangeCode: async () => permanent,
  identity: async () => permanent,
  publicDocuments: async ({ app }) => {
    derived += 1;
    return { "app.json": { client_id: app?.clientId ?? null } };
  },
};

let lateDerived = 0;
const late: ProviderAdapter["connect"] = {
  ...withApp,
  publicDocuments: async ({ app }) => {
    lateDerived += 1;
    return { "app.json": { client_id: app?.clientId ?? null } };
  },
};
let clock = Date.now();

// A careless adapter that puts the private member into its key set must still never publish it.
const PROVIDERS = {
  docs_late: { manifest: manifestOf("docs_late"), adapter: adapterOf(late) },
  docs_ok: {
    manifest: manifestOf("docs_ok"),
    adapter: adapterOf(
      connectWith({
        "client-metadata.json": { client_id: "https://app.example.test/x" },
        "jwks.json": { keys: [{ kty: "EC", crv: "P-256", x: "x1", y: "y1", kid: "k1", d: PRIVATE }] },
      }),
    ),
  },
  docs_app: { manifest: manifestOf("docs_app"), adapter: adapterOf(withApp) },
  docs_none: {
    manifest: manifestOf("docs_none"),
    adapter: adapterOf({
      authorize: async () => ({ url: "https://issuer.example.test/" }),
      exchangeCode: async () => permanent,
      identity: async () => permanent,
    }),
  },
};

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture({
    channels: { providers: PROVIDERS, fetch, pepper: new SealedSecret(PEPPER) },
    now: () => clock,
  });
  await withTenant(fx.db.pool("worker"), { principalKind: "job", principalId: randomUUID() }, (tx) =>
    ensureProviderApp(tx, keys, "docs_app", null, {
      clientId: "docs-app-client",
      clientSecret: new SealedSecret("docs-app-secret"),
      redirectUri: "https://app.example.test/x",
    }),
  );
});
afterAll(() => fx.close());

const get = (provider: string, name: string) => fx.request(`/api/v1/provider-documents/${provider}/${name}`);

describe("the public provider documents (floor)", () => {
  it("serves an allowlisted document with no session and a public cache header", async () => {
    const answer = await get("docs_ok", "client-metadata.json");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toMatch(/public/);
    expect(await answer.json()).toEqual({ client_id: "https://app.example.test/x" });
  });

  it("gives the adapter the app of the provider to build a document from, and never the secret to the reader", async () => {
    const answer = await get("docs_app", "app.json");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ client_id: "docs-app-client" });
  });

  it("derives a provider's documents once for many reads, so a flood of reads unseals nothing more", async () => {
    await get("docs_app", "app.json");
    const before = derived;
    await Promise.all(Array.from({ length: 20 }, () => get("docs_app", "app.json")));
    expect(derived).toBe(before);
  });
});

describe("the documents kept in memory", () => {
  it("keeps nothing built before the provider's app exists, and derives again after a minute on the app's clock", async () => {
    const first = await get("docs_late", "app.json");
    expect(await first.json()).toEqual({ client_id: null });
    await get("docs_late", "app.json");
    expect(lateDerived).toBe(2);
    await withTenant(fx.db.pool("worker"), { principalKind: "job", principalId: randomUUID() }, (tx) =>
      ensureProviderApp(tx, keys, "docs_late", null, {
        clientId: "late-client",
        clientSecret: new SealedSecret("late-secret"),
        redirectUri: "https://app.example.test/x",
      }),
    );
    expect(await (await get("docs_late", "app.json")).json()).toEqual({ client_id: "late-client" });
    await get("docs_late", "app.json");
    expect(lateDerived).toBe(3);
    clock += 61_000;
    await get("docs_late", "app.json");
    expect(lateDerived).toBe(4);
  });

  it.each([
    ["an unknown provider", "no_such", "jwks.json"],
    ["a provider with no documents", "docs_none", "jwks.json"],
    ["a name the adapter did not publish", "docs_ok", "secrets.json"],
    ["a traversal in the name", "docs_ok", "..%2Fjwks.json"],
    ["an inherited property name", "docs_ok", "constructor"],
  ])("%s is refused and nothing is served", async (_name, provider, name) => {
    expect((await get("docs_ok", "client-metadata.json")).status).toBe(200);
    const answer = await get(provider, name);
    expect([400, 404]).toContain(answer.status);
    expect(await answer.text()).not.toContain(PRIVATE);
  });

  it("never answers the private member of a key", async () => {
    const answer = await get("docs_ok", "jwks.json");
    const body = await answer.text();
    expect(answer.status).toBe(200);
    expect(body).toContain('"kid"');
    expect(body).not.toContain(PRIVATE);
    expect(JSON.stringify(JSON.parse(body))).not.toMatch(/"d"\s*:/);
    expect(fx.logged.join("\n")).not.toContain(PRIVATE);
  });
});
