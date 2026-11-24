import { createHash } from "node:crypto";
import type { DBAdapter, DBAdapterInstance, DBTransactionAdapter } from "better-auth";

const PREFIX = "h1:";

export const tokenDigest = (raw: string): string =>
  raw.startsWith(PREFIX) ? raw : `${PREFIX}${createHash("sha256").update(raw).digest("hex")}`;

interface Clause {
  field: string;
  value: unknown;
  [key: string]: unknown;
}
interface Call {
  model: string;
  where?: Clause[];
  data?: Record<string, unknown>;
}
type Method = (call: Call) => Promise<unknown>;
type Known = Map<string, string>;

const isTokenClause = (call: Call, clause: Clause): boolean =>
  call.model === "session" && clause.field === "token";

function digestWhere(call: Call): { where: Clause[] | undefined; known: Known } {
  const known: Known = new Map();
  const digest = (value: unknown): unknown => {
    if (typeof value !== "string" || value.startsWith(PREFIX)) return value;
    const stored = tokenDigest(value);
    known.set(stored, value);
    return stored;
  };
  const where = call.where?.map((clause) =>
    isTokenClause(call, clause)
      ? { ...clause, value: Array.isArray(clause.value) ? clause.value.map(digest) : digest(clause.value) }
      : clause,
  );
  return { where, known };
}

/** A row the library reads back by raw token must carry the raw token again: the cookie is set from it. */
function restore(result: unknown, known: Known): unknown {
  if (Array.isArray(result)) return result.map((row) => restore(row, known));
  if (result === null || typeof result !== "object") return result;
  const token = (result as { token?: unknown }).token;
  const raw = typeof token === "string" ? known.get(token) : undefined;
  return raw === undefined ? result : { ...result, token: raw };
}

const byWhere =
  (inner: Method): Method =>
  async (call) => {
    const { where, known } = digestWhere(call);
    return restore(await inner({ ...call, ...(where ? { where } : {}) }), known);
  };

const create =
  (inner: Method): Method =>
  async (call) => {
    const raw = call.data?.token;
    if (call.model !== "session" || typeof raw !== "string") return inner(call);
    const stored = await inner({ ...call, data: { ...call.data, token: tokenDigest(raw) } });
    return restore(stored, new Map([[tokenDigest(raw), raw]]));
  };

const WHERE_METHODS = [
  "findOne",
  "findMany",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
] as const;
const ONE_ROW_METHODS = ["consumeOne", "incrementOne"] as const;

// Patched in place because the library's schema check is registered against this very object. A transaction hands
// its callback a fresh adapter, which is patched too.
function patch<A extends DBAdapter | DBTransactionAdapter>(adapter: A): A {
  const target = adapter as unknown as Record<string, Method>;
  for (const name of [...WHERE_METHODS, ...ONE_ROW_METHODS]) {
    const inner = target[name];
    if (inner) target[name] = byWhere(inner);
  }
  const createInner = target.create;
  if (createInner) target.create = create(createInner);
  const transaction = (adapter as { transaction?: DBAdapter["transaction"] }).transaction;
  if (transaction) {
    (adapter as { transaction: DBAdapter["transaction"] }).transaction = (callback) =>
      transaction((trx) => callback(patch(trx)));
  }
  return adapter;
}

/** The adapter wrapper that keeps raw session tokens out of the database; the library lacks this at the pin. */
export const digestSessionTokens =
  (factory: DBAdapterInstance): DBAdapterInstance =>
  (options) =>
    patch(factory(options));
