import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

interface Claim {
  db: () => TestDatabase;
  auth: () => Pool;
  addUser: (verified: boolean) => Promise<string>;
  claim: (id: string) => Promise<boolean>;
  admins: () => Promise<{ user_id: string; granted_by: string | null }[]>;
}

/** A fresh database per row: the claim is one-shot. Users are made through the auth role, as sign-up does. */
function useClaimDatabase(): Claim {
  let db: TestDatabase;
  let auth: Pool;
  beforeEach(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    auth = db.pool("auth");
  });
  afterEach(() => db.drop());
  return {
    db: () => db,
    auth: () => auth,
    async addUser(verified) {
      const id = randomUUID();
      await auth.query(
        `INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1::uuid, $1::text, $1::text || '@example.test', $2)`,
        [id, verified],
      );
      return id;
    },
    async claim(id) {
      return (await auth.query("SELECT app.instance_admin_claim($1) AS won", [id])).rows[0].won;
    },
    admins: () =>
      withAdminClient(
        env,
        db.name,
        async (admin) =>
          (await admin.query("SELECT user_id, granted_by FROM app.instance_admins ORDER BY granted_at")).rows,
      ),
  };
}

// Security floor: the first verified user becomes the instance owner, once, even under a race, and a deleted
// founder never reopens the claim while any admin row exists.
describe("instance_admin_claim: who wins", () => {
  const t = useClaimDatabase();

  it("two concurrent calls make one owner", async () => {
    const [first, second] = [await t.addUser(true), await t.addUser(true)];
    const one = await t.auth().connect();
    const two = await t.auth().connect();
    // A connection that fails mid-way is destroyed, never returned to the pool with a transaction open.
    let clean = false;
    try {
      // The first call holds its insert uncommitted; the second runs while it is in flight and must wait for it.
      await one.query("BEGIN");
      const won = (await one.query("SELECT app.instance_admin_claim($1) AS won", [first])).rows[0].won;
      const pending = two.query("SELECT app.instance_admin_claim($1) AS won", [second]);
      pending.catch(() => undefined);
      await delay(300);
      await one.query("COMMIT");
      // The second answer is read only after the first transaction has committed.
      expect([won, (await pending).rows[0].won]).toEqual([true, false]);
      clean = true;
    } finally {
      one.release(!clean);
      two.release(!clean);
    }
    expect(await t.admins()).toEqual([{ user_id: first, granted_by: null }]);
  });

  it("a later call is refused", async () => {
    const [first, later] = [await t.addUser(true), await t.addUser(true)];
    expect(await t.claim(first)).toBe(true);
    expect(await t.claim(later)).toBe(false);
    expect(await t.claim(first)).toBe(false);
    expect((await t.admins()).map((row) => row.user_id)).toEqual([first]);
  });

  it("a call after the founder row is deleted while another admin remains is refused", async () => {
    const [founder, other, late] = [await t.addUser(true), await t.addUser(true), await t.addUser(true)];
    expect(await t.claim(founder)).toBe(true);
    await withAdminClient(env, t.db().name, async (admin) => {
      await admin.query("INSERT INTO app.instance_admins (user_id, granted_by) VALUES ($1, $2)", [
        other,
        founder,
      ]);
      await admin.query("DELETE FROM app.instance_admins WHERE granted_by IS NULL");
    });
    expect(await t.claim(late)).toBe(false);
    expect((await t.admins()).map((row) => row.user_id)).toEqual([other]);
  });

  it.each([
    ["an unverified user", false],
    ["a user id that does not exist", undefined],
  ])("%s is refused and writes nothing", async (_title, verified) => {
    expect(await t.claim(verified === undefined ? randomUUID() : await t.addUser(verified))).toBe(false);
    expect(await t.admins()).toEqual([]);
  });
});

describe("instance_admin_claim: who may call it and what the definer reads", () => {
  const t = useClaimDatabase();

  it.each(["app", "worker", "readonly"] as const)(
    "shoutory_%s cannot call it (permission denied)",
    async (key) => {
      const user = await t.addUser(true);
      const call = t.db().pool(key).query("SELECT app.instance_admin_claim($1)", [user]);
      await expect(call).rejects.toMatchObject({ code: "42501" });
    },
  );

  // The definer role reads these columns of auth.user and no others: id and email_verified (granted with the claim
  // definer) and name and image (granted with the access definers). A later grant adds its columns here.
  const DEFINER_USER_COLUMNS = ["email_verified", "id", "image", "name"];

  it("the definer role holds column SELECT on exactly the matrix columns of auth.user", async () => {
    const found = await t
      .db()
      .pool("owner")
      .query(
        `SELECT a.attname FROM pg_attribute a
       WHERE a.attrelid = 'auth."user"'::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege('shoutory_definer', a.attrelid, a.attnum, 'SELECT')
       ORDER BY a.attname`,
      );
    expect(found.rows.map((row) => row.attname)).toEqual(DEFINER_USER_COLUMNS);
  });

  it("the definer is refused on auth.user.email with permission denied", async () => {
    const client = await t.db().pool("owner").connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE shoutory_definer");
      const read = client.query(`SELECT email FROM auth."user"`);
      await expect(read).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
