import { cloneTemplate, readTestEnv, type TestDatabase } from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type JobQueue, parseJobPayload } from "../../src/jobs/registry.js";

const env = readTestEnv();
const WORKSPACE = "00000000-0000-7000-8000-000000000001";

describe("job payloads", () => {
  it.each<[JobQueue, unknown, boolean]>([
    ["ensure_partitions", {}, true],
    ["purge_expired", { class: "outbox" }, true],
    ["ensure_partitions", { role: "owner" }, false],
    ["ensure_partitions", { workspaceId: WORKSPACE }, false],
    ["media_gc", {}, true],
    ["media_gc", { role: "owner" }, false],
    ["media_gc", { workspaceId: WORKSPACE }, false],
    ["sweep_upload_parts", {}, true],
    ["sweep_upload_parts", { role: "owner" }, false],
    ["sweep_upload_parts", { root: "/etc" }, false],
    ["credential_refresh", {}, true],
    ["credential_refresh", { workspaceId: WORKSPACE }, false],
    ["purge_expired", { class: "outbox", role: "owner" }, false],
    ["purge_expired", { class: "outbox", workspaceId: WORKSPACE }, false],
    ["purge_expired", { class: "outbox", scope: { workspaceIds: [WORKSPACE] } }, false],
  ])("on %s %j: accepted is %s, a role or scope field is refused", (queue, payload, accepted) => {
    if (accepted) {
      expect(parseJobPayload(queue, payload)).toEqual(payload);
      return;
    }
    expect(() => parseJobPayload(queue, payload)).toThrow();
  });
});

describe("the queue library's schema", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());

  it("is installed, and shoutory_app cannot read or write any table of it", async () => {
    const installed = await db.pool("owner").query("SELECT to_regclass('pgboss.job') IS NOT NULL AS found");
    expect(installed.rows[0]).toEqual({ found: true });
    const app = db.pool("app");
    await expect(app.query("SELECT count(*) FROM pgboss.job")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("SELECT count(*) FROM pgboss.queue")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("DELETE FROM pgboss.schedule")).rejects.toMatchObject({ code: "42501" });
  });
});
