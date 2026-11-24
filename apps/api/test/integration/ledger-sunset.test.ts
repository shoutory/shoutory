import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Env, makeEnv, opOf, plant, rows, useDispatchEnv } from "../support/ledger-dispatch-env.js";

useDispatchEnv();

const NOW = new Date("2026-11-23T12:00:00Z");
const version = (name: string, introduced: string, sunset?: string) => ({
  version: name,
  introduced,
  ...(sunset === undefined ? {} : { sunset }),
  docsUrl: `https://docs.fixture.example/api/${name}`,
  checked: "2026-11-21",
});
const bucketOf = async (id: string, providerId: string): Promise<number> => {
  const [row] = await rows(
    `SELECT c.provider_account_id AS account FROM app.channels c JOIN app.operations o ON o.channel_id = c.id
      WHERE o.id = $1`,
    [id],
  );
  const key = createHash("sha256")
    .update([providerId, "posts", "account", String(row?.account)].join("\0"))
    .digest("hex");
  return (await rows("SELECT 1 FROM app.rate_buckets WHERE scope = 'account' AND key = $1", [key])).length;
};

// [what retired, the manifest]: each is past its sunset at NOW, 2026-11-23 12:00 UTC
const PAST: [string, Record<string, unknown>][] = [
  ["the sunset date is today", { apiVersions: [version("v1", "2026-01-01", "2026-11-23")] }],
  ["the whole provider retires", { apiVersions: [version("v1", "2026-01-01")], sunset: "2026-11-01" }],
];
describe("a claimed operation of a provider past its sunset", () => {
  it.each(PAST)(
    "is paused with api_sunset when %s, sends nothing, takes no bucket token and is never resent",
    async (_name, manifest) => {
      const e = await makeEnv({ manifest, clock: () => NOW });
      try {
        const id = await plant(e);
        expect(await e.turn()).toMatchObject({ kind: "moved", to: "paused", id });
        expect(await opOf(id)).toMatchObject({ state: "paused", reason_code: "api_sunset", attempts: 0 });
        expect(await bucketOf(id, e.providerId)).toBe(0);
        await e.tick();
        expect(await e.turn()).toMatchObject({ kind: "idle" });
        expect(await opOf(id)).toMatchObject({ state: "paused", reason_code: "api_sunset", attempts: 0 });
        expect([e.commits.count, e.sim.effects()]).toEqual([0, 0]);
      } finally {
        await e.close();
      }
    },
  );
});

// [what is live, the manifest]: each has a version in force at NOW
const LIVE: [string, Record<string, unknown>][] = [
  ["the sunset date is tomorrow", { apiVersions: [version("v1", "2026-01-01", "2026-11-24")] }],
];
describe("a claimed operation of a provider with a version in force", () => {
  it.each(LIVE)("is dispatched when %s", async (_name, manifest) => {
    const e = await makeEnv({ manifest, clock: () => NOW });
    try {
      const id = await plant(e);
      expect(await e.turn()).toMatchObject({ kind: "dispatched", id });
      expect(await opOf(id)).toMatchObject({ state: "published" });
    } finally {
      await e.close();
    }
  });
});

const RETIRED = { apiVersions: [version("v1", "2026-01-01", "2026-11-22")] };
const NEWER = { apiVersions: [version("v1", "2026-01-01", "2026-11-22"), version("v2", "2026-11-01")] };
const paused = (e: Env) =>
  plant(e, { state: "paused", effect: "none", reason: "api_sunset", waitSeconds: 3600 });
describe("the live list of the tick", () => {
  it("is computed at each tick: a provider that retires between two ticks leaves it, a newer version brings it back", async () => {
    const e = await makeEnv({ manifest: { apiVersions: [version("v1", "2026-01-01", "2026-11-24")] } });
    try {
      const live = await paused(e);
      await e.tickWith({}, NOW);
      expect((await opOf(live)).state).toBe("pending");
      const retired = await paused(e);
      await e.tickWith(RETIRED, new Date("2026-11-25T12:00:00Z"));
      expect(await opOf(retired)).toMatchObject({ state: "paused", reason_code: "api_sunset" });
      await e.tickWith(NEWER, new Date("2026-11-25T12:00:00Z"));
      expect((await opOf(retired)).state).toBe("pending");
    } finally {
      await e.close();
    }
  });

  it("leaves a retired provider's row at its last attempt waiting, and fails it once a live version is named", async () => {
    const e = await makeEnv({ clock: () => NOW });
    try {
      const id = await plant(e, { state: "retry_wait", effect: "none", attempts: 5, waitSeconds: 3600 });
      await e.tickWith(RETIRED, NOW);
      expect((await opOf(id)).state).toBe("retry_wait");
      await e.tickWith(NEWER, NOW);
      expect((await opOf(id)).state).toBe("failed");
    } finally {
      await e.close();
    }
  });
});
