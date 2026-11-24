import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

// Time moves by editing `at` as the superuser: nothing sleeps.
describe("step_up_record and step_up_read", () => {
  let db: TestDatabase;
  let auth: Pool;
  const user = randomUUID();
  const [sessionA, sessionB, sessionC] = [randomUUID(), randomUUID(), randomUUID()];
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    auth = db.pool("auth");
    await auth.query(
      `INSERT INTO auth."user" (id, name, email) VALUES ($1, 'step-up-1', 'step-up-1@example.test')`,
      [user],
    );
  });
  afterAll(() => db.drop());

  const record = (session: string, method: string) =>
    auth.query("SELECT app.step_up_record($1, $2, $3)", [session, user, method]);
  const read = async (session: string, who = user) =>
    (await auth.query("SELECT method FROM app.step_up_read($1, $2)", [session, who])).rows;
  const shift = (minutes: number, session: string) =>
    withAdminClient(env, db.name, (admin) =>
      admin.query(
        "UPDATE app.session_step_ups SET at = at - make_interval(mins => $1) WHERE session_id = $2",
        [minutes, session],
      ),
    );

  it("returns the newest record of that session only", async () => {
    await record(sessionA, "password");
    await shift(5, sessionA);
    await record(sessionA, "totp");
    await record(sessionB, "password");
    expect(await read(sessionA)).toEqual([{ method: "totp" }]);
    expect(await read(sessionB)).toEqual([{ method: "password" }]);
    expect(await read(sessionC)).toEqual([]);
  });

  it("returns nothing for another user's id with the right session id", async () => {
    const session = randomUUID();
    await record(session, "password");
    expect(await read(session)).toEqual([{ method: "password" }]);
    expect(await read(session, randomUUID())).toEqual([]);
  });

  it("returns nothing once the newest record is older than 10 minutes", async () => {
    await record(sessionC, "totp");
    await shift(9, sessionC);
    expect(await read(sessionC)).toEqual([{ method: "totp" }]);
    await shift(2, sessionC);
    expect(await read(sessionC)).toEqual([]);
  });
});
