import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withSystem } from "../../src/context/with-system.js";
import { cloneTemplate, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());

const SEEN = "SELECT app.principal_kind() AS kind, app.job_purpose() AS purpose, app.ws_ids()::text[] AS ids";

describe("withSystem", () => {
  it("runs as a job with the purpose named and no workspace", async () => {
    const inside = await withSystem(db.pool("worker"), "outbox_relay", (tx) => tx.query(SEEN));
    expect(inside.rows[0]).toEqual({ kind: "job", purpose: "outbox_relay", ids: [] });
  });

  it("runs the ledger runtime's jobs under the ledger purpose", async () => {
    const inside = await withSystem(db.pool("worker"), "ledger", (tx) => tx.query(SEEN));
    expect(inside.rows[0]).toEqual({ kind: "job", purpose: "ledger", ids: [] });
  });

  it.each(["", "unknown", "outbox_relay'; --", "OUTBOX_RELAY"])(
    "the purpose %j is refused before any statement runs",
    async (purpose) => {
      let ran = false;
      const refused = withSystem(db.pool("worker"), purpose as "heartbeat", async () => {
        ran = true;
      });
      await expect(refused).rejects.toThrow();
      expect(ran).toBe(false);
    },
  );
});
