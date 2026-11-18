import { NIL_SCOPE, open, type StoredSecret, seal } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { run } from "../../src/cli/main.js";

const env = readTestEnv();
const KEK = (n: number) => Buffer.alloc(32, n).toString("base64");
const WORKSPACE = "11111111-1111-7111-8111-111111111111";
const LINK = "https://app.example.test/auth/verify#token=reseal-link-canary-1";
// Time-ordered ids, so the batch order is the insert order.
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const ring = (active: string) =>
  new EnvKeyProvider({
    SHOUTORY_ACTIVE_KEY_ID: active,
    SHOUTORY_KEK_K1: KEK(1),
    SHOUTORY_KEK_K2: KEK(2),
  });
/** A key that no process in these tests has loaded. */
const lostSeal = (n: number) =>
  seal(
    LINK,
    aad(n, null, 0),
    new EnvKeyProvider({ SHOUTORY_ACTIVE_KEY_ID: "gone", SHOUTORY_KEK_GONE: KEK(9) }),
  );
const aad = (n: number, workspaceId: string | null, generation: number) =>
  ({
    formatVersion: 1,
    scopeId: workspaceId ?? NIL_SCOPE,
    ownerId: id(n),
    credentialKind: "email_link",
    generation,
  }) as const;

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());
beforeEach(() => withAdminClient(env, db.name, (admin) => admin.query("DELETE FROM app.email_outbox")));

/** A row sealed under the ring's active key at `generation`. */
async function seed(
  n: number,
  keys: EnvKeyProvider,
  workspaceId: string | null,
  generation = 0,
): Promise<void> {
  const s = seal(LINK, aad(n, workspaceId, generation), keys);
  await insert(n, workspaceId, generation, s);
}
async function insert(
  n: number,
  workspaceId: string | null,
  generation: number,
  s: StoredSecret,
): Promise<void> {
  await withAdminClient(env, db.name, (admin) =>
    admin.query(
      `INSERT INTO app.email_outbox (id, workspace_id, recipient, template, locale, vars, link_ciphertext, link_iv,
         link_auth_tag, link_wrap_iv, link_wrap_tag, link_wrapped_dek, link_key_id, link_format_version,
         link_generation, link_digest)
       VALUES ($1, $2, 'reseal-1@example.test', 'verify_email', 'en', '{}', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id(n),
        workspaceId,
        s.ciphertext,
        s.iv,
        s.tag,
        s.wrapIv,
        s.wrapTag,
        s.wrappedDek,
        s.keyId,
        s.formatVersion,
        generation,
        "d".repeat(64),
      ],
    ),
  );
}
/** Rows `from`..`to` at generation 0 in one statement: each is sealed on its own id, then all are unnested. */
async function seedMany(from: number, to: number, keys: EnvKeyProvider): Promise<void> {
  const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const sealed = numbers.map((n) => seal(LINK, aad(n, null, 0), keys));
  const column = (pick: (s: StoredSecret) => Buffer) => sealed.map(pick);
  await withAdminClient(env, db.name, (admin) =>
    admin.query(
      `INSERT INTO app.email_outbox (id, recipient, template, locale, vars, link_ciphertext, link_iv, link_auth_tag,
         link_wrap_iv, link_wrap_tag, link_wrapped_dek, link_key_id, link_format_version, link_generation, link_digest)
       SELECT i, 'reseal-1@example.test', 'verify_email', 'en', '{}', c, v, t, wi, wt, wd, $8, 1, 0, $9
       FROM unnest($1::uuid[], $2::bytea[], $3::bytea[], $4::bytea[], $5::bytea[], $6::bytea[], $7::bytea[])
         AS u (i, c, v, t, wi, wt, wd)`,
      [
        numbers.map(id),
        column((s) => s.ciphertext),
        column((s) => s.iv),
        column((s) => s.tag),
        column((s) => s.wrapIv),
        column((s) => s.wrapTag),
        column((s) => s.wrappedDek),
        keys.activeKeyId(),
        "d".repeat(64),
      ],
    ),
  );
}
async function seedSent(n: number): Promise<void> {
  await withAdminClient(env, db.name, (admin) =>
    admin.query(
      `INSERT INTO app.email_outbox (id, recipient, template, locale, vars, state, link_digest)
       VALUES ($1, 'sent-1@example.test', 'verify_email', 'en', '{}', 'sent', $2)`,
      [id(n), "d".repeat(64)],
    ),
  );
}

interface Stored {
  id: string;
  link_key_id: string | null;
  link_generation: number | null;
  link_ciphertext: Buffer | null;
}
const rows = () =>
  withAdminClient(
    env,
    db.name,
    async (admin) =>
      (
        await admin.query(
          "SELECT id, link_key_id, link_generation, link_ciphertext FROM app.email_outbox ORDER BY id",
        )
      ).rows as Stored[],
  );

function command(argv: string[], active: string, extra: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const environment = {
    SHOUTORY_DATABASE_URL_WORKER: db.url("worker"),
    SHOUTORY_ACTIVE_KEY_ID: active,
    SHOUTORY_KEK_K1: KEK(1),
    SHOUTORY_KEK_K2: KEK(2),
    ...extra,
  };
  const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
  return { done: run(argv, environment, io), text: () => [...out, ...err].join("\n") };
}

describe("shoutory secrets reseal", () => {
  it("rewrites every sealed link to the active key with generation + 1, skips sent rows and is idempotent", async () => {
    const old = ring("k1");
    await seed(1, old, null, 3);
    await seed(2, old, WORKSPACE, 0);
    await seed(3, ring("k2"), null, 7);
    await seedSent(4);
    const before = await rows();

    const first = command(["secrets", "reseal"], "k2");
    expect(await first.done).toBe(0);
    const after = await rows();
    expect(after.map((r) => [r.link_key_id, r.link_generation])).toEqual([
      ["k2", 4],
      ["k2", 1],
      ["k2", 7],
      [null, null],
    ]);
    // The untouched rows are byte-identical, and a rewritten row opens under its new generation and scope.
    expect(after[2]?.link_ciphertext).toEqual(before[2]?.link_ciphertext);
    expect(after[3]).toEqual(before[3]);
    expect(after[0]?.link_ciphertext).not.toEqual(before[0]?.link_ciphertext);
    // Output carries counts and key ids only, never a row id or the link.
    for (const row of before) expect(first.text()).not.toContain(row.id);
    expect(first.text()).not.toContain("reseal-link-canary-1");

    const second = command(["secrets", "reseal"], "k2");
    expect(await second.done).toBe(0);
    expect(await rows()).toEqual(after);
  });

  it("a row sealed under a key with no loaded key is skipped and counted, and does not stall the rest", async () => {
    // The unopenable row has the lowest id; 120 more exceed one batch, so a run with no cursor would stall on it.
    await insert(1, null, 0, lostSeal(1));
    const old = ring("k1");
    await seedMany(2, 121, old);

    const result = command(["secrets", "reseal"], "k2");
    expect(await result.done).toBe(1);
    const after = await rows();
    expect(after[0]?.link_key_id).toBe("gone");
    expect(after.slice(1).every((r) => r.link_key_id === "k2" && r.link_generation === 1)).toBe(true);
    expect(result.text()).toContain("gone");
    expect(result.text()).not.toContain(id(1));
  });
});

describe("shoutory secrets reseal: a write another writer pre-empted", () => {
  const plant = (sql: string) => withAdminClient(env, db.name, (admin) => admin.query(sql));

  it("is counted apart from the rewritten rows, leaves the row alone and still exits 0", async () => {
    await seed(1, ring("k1"), null, 0);
    // A trigger that swallows the update is what a writer that got there first looks like to the write.
    await plant(
      `CREATE FUNCTION app.swallow_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
    );
    await plant(
      "CREATE TRIGGER swallow BEFORE UPDATE ON app.email_outbox FOR EACH ROW EXECUTE FUNCTION app.swallow_update()",
    );
    try {
      const before = await rows();
      const result = command(["secrets", "reseal"], "k2");
      expect(await result.done).toBe(0);
      expect(result.text()).toContain("resealed 0 under k2");
      expect(result.text()).toContain("moved by another writer: 1");
      expect(await rows()).toEqual(before);
    } finally {
      await plant("DROP TRIGGER swallow ON app.email_outbox");
      await plant("DROP FUNCTION app.swallow_update()");
    }
  });
});

describe("shoutory secrets reseal: the stored result", () => {
  it("a rewritten link opens under the new generation and its scope, and not under the old one", async () => {
    await seed(1, ring("k1"), WORKSPACE, 2);
    expect(await command(["secrets", "reseal"], "k2").done).toBe(0);
    const [row] = await withAdminClient(
      env,
      db.name,
      async (admin) =>
        (await admin.query("SELECT * FROM app.email_outbox")).rows as Record<
          string,
          Buffer | string | number
        >[],
    );
    const stored: StoredSecret = {
      formatVersion: row?.link_format_version as number,
      keyId: row?.link_key_id as string,
      iv: row?.link_iv as Buffer,
      ciphertext: row?.link_ciphertext as Buffer,
      tag: row?.link_auth_tag as Buffer,
      wrapIv: row?.link_wrap_iv as Buffer,
      wrapTag: row?.link_wrap_tag as Buffer,
      wrappedDek: row?.link_wrapped_dek as Buffer,
    };
    expect(open(stored, aad(1, WORKSPACE, 3), ring("k2")).expose()).toBe(LINK);
    expect(() => open(stored, aad(1, WORKSPACE, 2), ring("k2"))).toThrow();
  });
});

describe("shoutory secrets check", () => {
  it("exits 0 once nothing is left under a key but the active one, and 1 naming each key id apart otherwise", async () => {
    await seed(1, ring("k1"), null);
    const stale = command(["secrets", "check"], "k2");
    expect(await stale.done).toBe(1);
    expect(stale.text()).toMatch(/not active.*k1/i);
    expect(stale.text()).not.toContain(id(1));

    expect(await command(["secrets", "reseal"], "k2").done).toBe(0);
    expect(await command(["secrets", "check"], "k2").done).toBe(0);

    // A row under a key the process has no key for is named as not loaded.
    await insert(2, null, 0, lostSeal(2));
    const missing = command(["secrets", "check"], "k2");
    expect(await missing.done).toBe(1);
    expect(missing.text()).toMatch(/not loaded.*gone/i);
  });
});
