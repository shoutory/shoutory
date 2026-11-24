import { cloneTemplate, readTestEnv, type TestDatabase } from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createBoss } from "../../src/jobs/boss.js";

const env = readTestEnv();

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());

describe("the worker role's queue client", () => {
  // The owner installed the queue schema and queues; the runtime role needs DML and function EXECUTE only.
  it("starts, sends, works and supervises as shoutory_worker, which holds no DDL privilege", async () => {
    const errors: Error[] = [];
    const boss = createBoss(db.url("worker"), (error) => errors.push(error));
    try {
      await boss.start();
      const seen = new Promise<unknown>((resolve) => {
        void boss.work<{ class: string }>("purge_expired", async ([job]) => resolve(job?.data));
      });
      await boss.send("purge_expired", { class: "outbox" });
      expect(await seen).toEqual({ class: "outbox" });
      await boss.supervise();
      expect(errors).toEqual([]);
    } finally {
      await boss.stop({ graceful: false });
    }
    const worker = db.pool("worker");
    await expect(worker.query("CREATE TABLE pgboss.ddl_probe (x int)")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(worker.query("CREATE SCHEMA ddl_probe")).rejects.toMatchObject({ code: "42501" });
  });
});
