import { open, SealedSecret, type StoredSecret } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { emailLinkAad, enqueueMail } from "./enqueue.js";

const deps = {
  keys: new EnvKeyProvider({
    SHOUTORY_ACTIVE_KEY_ID: "k1",
    SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
  }),
  pepper: new SealedSecret("enqueue-unit-pepper-0123456789abcdef"),
};
const valid = {
  workspaceId: null,
  recipient: "unit-1@example.test",
  template: "verify_email",
  locale: "en",
  vars: {},
  link: "https://app.example.test/auth/verify#token=unit-1",
} as const;

/** A pool that counts every use and fails it: a refusal must happen before the database is touched. */
function countingPool(): { pool: AppPool; calls: () => number; params: () => unknown[] } {
  const seen: unknown[][] = [];
  const pool = {
    query: (_sql: string, params: unknown[] = []) => {
      seen.push(params);
      throw new Error("pool used");
    },
  } as unknown as AppPool;
  return { pool, calls: () => seen.length, params: () => seen[0] ?? [] };
}

describe("enqueueMail refuses before it touches the database", () => {
  it.each([
    ["an unknown template", { template: "welcome" }],
    ["a var the template does not declare", { vars: { token: "x" } }],
    ["a recipient that is not an address", { recipient: "not-an-address" }],
    ["a link over the bound", { link: `https://app.example.test/${"a".repeat(3000)}` }],
    ["a field that is not part of a mail", { sendNow: true }],
  ])("%s", async (_name, change) => {
    const { pool, calls } = countingPool();
    await expect(enqueueMail(pool, { ...valid, ...change } as never, deps)).rejects.toBeInstanceOf(ZodError);
    expect(calls()).toBe(0);
  });

  it("a valid mail does reach the pool, so the counter above can fail", async () => {
    const { pool, calls } = countingPool();
    await expect(enqueueMail(pool, valid, deps)).rejects.toThrow("pool used");
    expect(calls()).toBe(1);
  });
});

describe("enqueueMail ids", () => {
  it("an upper-case id and workspace are stored lower-case and the link opens under that AAD", async () => {
    const id = "0194A1B2-C3D4-7E5F-8A6B-7C8D9E0F1A2B";
    const workspace = "11111111-AAAA-7111-8111-111111111111";
    const { pool, params } = countingPool();
    await expect(enqueueMail(pool, { ...valid, id, workspaceId: workspace }, deps)).rejects.toThrow(
      "pool used",
    );
    // The definer call carries the id, the workspace and the sealed fields, in the order of its signature.
    const sent = params() as (string | Buffer)[];
    expect(sent.slice(0, 2)).toEqual([id.toLowerCase(), workspace.toLowerCase()]);
    const stored: StoredSecret = {
      ciphertext: sent[6] as Buffer,
      iv: sent[7] as Buffer,
      tag: sent[8] as Buffer,
      wrapIv: sent[9] as Buffer,
      wrapTag: sent[10] as Buffer,
      wrappedDek: sent[11] as Buffer,
      keyId: sent[12] as string,
      formatVersion: sent[13] as unknown as number,
    };
    const aad = emailLinkAad(id.toLowerCase(), workspace.toLowerCase(), 0);
    expect(open(stored, aad, deps.keys).expose()).toBe(valid.link);
  });
});
