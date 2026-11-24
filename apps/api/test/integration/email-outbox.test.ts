import { createHmac } from "node:crypto";
import { NIL_SCOPE, open, SealedSecret, type StoredSecret } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { enqueueMail } from "../../src/mail/enqueue.js";

const env = readTestEnv();
const keys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});
const PEPPER = "enqueue-pepper-for-tests-0123456789ab";
const deps = { keys, pepper: new SealedSecret(PEPPER) };
const WORKSPACE = "11111111-1111-7111-8111-111111111111";
// Characters that spell differently in every form the canary is searched for.
const LINK = 'https://app.example.test/auth/verify#token=canary+/="v\\1 a&b';
const mail = (extra: Record<string, unknown> = {}) => ({
  workspaceId: null,
  recipient: "enqueue-1@example.test",
  template: "verify_email" as const,
  locale: "en",
  vars: {},
  link: LINK,
  ...extra,
});

const spellings = (v: string): [string, Buffer][] => [
  ["raw", Buffer.from(v)],
  ["percent-encoded", Buffer.from(encodeURIComponent(v))],
  ["hex", Buffer.from(Buffer.from(v).toString("hex"))],
  ["base64", Buffer.from(Buffer.from(v).toString("base64"))],
  ["JSON-escaped", Buffer.from(JSON.stringify(v).slice(1, -1))],
];

let db: TestDatabase;
let authPool: AppPool;
let appPool: AppPool;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  authPool = db.pool("auth");
  appPool = db.pool("app");
  await withAdminClient(env, db.name, async (admin) => {
    const org = await admin.query(
      "INSERT INTO app.organizations (name, slug, type) VALUES ('enqueue-org', 'enqueue-org', 'team') RETURNING id",
    );
    await admin.query(
      "INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, 'enqueue', 'enqueue')",
      [WORKSPACE, org.rows[0].id],
    );
  });
});
afterAll(() => db.drop());

const stored = (id: string) =>
  withAdminClient(env, db.name, async (admin) => {
    const found = await admin.query("SELECT * FROM app.email_outbox WHERE id = $1", [id]);
    return found.rows[0] as Record<string, unknown>;
  });

describe("enqueueMail", () => {
  it.each(spellings(LINK))(
    "no column of the stored row holds the link in its %s form",
    async (_form, bytes) => {
      const id = await enqueueMail(authPool, mail(), deps);
      const row = await stored(id);
      const everything = Buffer.concat(
        Object.values(row).map((value) =>
          Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value) ?? ""),
        ),
      );
      expect(everything.includes(bytes)).toBe(false);
      expect(row.link_ciphertext).toBeInstanceOf(Buffer);
    },
  );

  it("keeps the HMAC of 'email_link:' and the link under the pepper as the digest", async () => {
    const id = await enqueueMail(appPool, mail(), deps);
    const expected = createHmac("sha256", Buffer.from(PEPPER)).update(`email_link:${LINK}`).digest("hex");
    expect((await stored(id)).link_digest).toBe(expected);
  });

  it("refuses a duplicate id with a unique violation", async () => {
    const first = await enqueueMail(authPool, mail(), deps);
    const again = enqueueMail(authPool, mail({ id: first }), deps);
    await expect(again).rejects.toMatchObject({ code: "23505" });
  });

  it("seals a workspace row so that it opens with that workspace scope only", async () => {
    const id = await enqueueMail(appPool, mail({ workspaceId: WORKSPACE }), deps);
    const row = await stored(id);
    const sealed: StoredSecret = {
      formatVersion: row.link_format_version as number,
      keyId: row.link_key_id as string,
      iv: row.link_iv as Buffer,
      ciphertext: row.link_ciphertext as Buffer,
      tag: row.link_auth_tag as Buffer,
      wrapIv: row.link_wrap_iv as Buffer,
      wrapTag: row.link_wrap_tag as Buffer,
      wrappedDek: row.link_wrapped_dek as Buffer,
    };
    const aad = (scopeId: string) =>
      ({ formatVersion: 1, scopeId, ownerId: id, credentialKind: "email_link", generation: 0 }) as const;
    expect(row.link_generation).toBe(0);
    expect(open(sealed, aad(WORKSPACE), keys).expose()).toBe(LINK);
    expect(() => open(sealed, aad(NIL_SCOPE), keys)).toThrow();
  });
});
