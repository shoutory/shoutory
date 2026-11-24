import type { DBAdapter } from "better-auth";
import { describe, expect, it } from "vitest";
import { digestSessionTokens, tokenDigest } from "./session-token.js";

interface Seen {
  method: string;
  call: Record<string, unknown>;
}

// A recording adapter: every method answers a row that carries the token it was given, as a database would.
function recording(seen: Seen[]): DBAdapter {
  const answer =
    (method: string) =>
    async (call: Record<string, unknown>): Promise<unknown> => {
      seen.push({ method, call });
      const where = call.where as { value: unknown }[] | undefined;
      const token = (call.data as { token?: string } | undefined)?.token ?? where?.[0]?.value;
      return method === "findMany" ? [{ token }] : { token };
    };
  const adapter: Record<string, unknown> = Object.fromEntries(
    ["create", "findOne", "findMany", "update", "updateMany", "delete", "deleteMany", "count"].map((name) => [
      name,
      answer(name),
    ]),
  );
  adapter.transaction = async (callback: (trx: unknown) => Promise<unknown>) => callback(adapter);
  return adapter as unknown as DBAdapter;
}

const RAW = "raw-session-token-0123456789abcdef";
const build = () => {
  const seen: Seen[] = [];
  const adapter = digestSessionTokens(() => recording(seen))({});
  return { adapter, seen };
};

describe("the session token wrapper", () => {
  // The create, read and sliding-refresh rows live in the integration level. Kept here: the `in` clause and the
  // digest pass-through, and the transaction's adapter, which no route reaches.
  it.each([
    ["a list of tokens", [RAW], [tokenDigest(RAW)]],
    ["a value that is already a digest", [tokenDigest(RAW)], [tokenDigest(RAW)]],
  ])("rewrites %s in an `in` clause and never hashes a digest again", async (_name, value, stored) => {
    const { adapter, seen } = build();
    await adapter.findMany({ model: "session", where: [{ field: "token", value, operator: "in" }] });
    expect(seen[0]?.call.where).toEqual([{ field: "token", value: stored, operator: "in" }]);
  });

  it("leaves other models and other session fields alone, and wraps the transaction's adapter", async () => {
    const { adapter, seen } = build();
    await adapter.findOne({ model: "user", where: [{ field: "token", value: RAW }] });
    await adapter.findOne({ model: "session", where: [{ field: "userId", value: RAW }] });
    const firstValue = (entry: Seen | undefined) => (entry?.call.where as { value: string }[])?.[0]?.value;
    expect(seen.map(firstValue)).toEqual([RAW, RAW]);
    await adapter.transaction(async (trx) => {
      await trx.delete({ model: "session", where: [{ field: "token", value: RAW }] });
    });
    expect(firstValue(seen[2])).toBe(tokenDigest(RAW));
  });
});
