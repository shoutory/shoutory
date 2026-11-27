import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageDriver } from "@shoutory/core/storage";
import type { AdapterContext, CommitInput, ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { createLogger } from "../../src/logging/logger.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { leaks } from "../support/canary.js";
import {
  admin,
  type Env,
  makeEnv,
  opOf,
  plant,
  rows,
  useDispatchEnv,
  workerPool,
} from "../support/ledger-dispatch-env.js";
import { type Pin, pinMedia } from "../support/ledger-media.js";

useDispatchEnv();

// The unavailable-kind guard: the worker has no turn for these kinds, so it must not run the publish path for them.
describe("a claimed operation that is not a publish (floor)", () => {
  it.each(["edit", "delete", "reply"])(
    "%s is settled needs_human with effect none and zero provider calls",
    async (kind) => {
      const calls: string[] = [];
      const e = await makeEnv({ before: (route) => void calls.push(route) });
      try {
        const id = await plant(e);
        await admin(async (client) => {
          await client.query("BEGIN");
          await client.query("SET LOCAL session_replication_role = replica");
          await client.query("UPDATE app.operations SET kind = $2 WHERE id = $1", [id, kind]);
          await client.query("COMMIT");
        });
        await e.turn();
        expect(await opOf(id)).toMatchObject({ state: "needs_human", effect: "none" });
        expect(calls).toEqual([]);
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});

let dir: string;
let real: StorageDriver;
const requested: string[] = [];
const lines: string[] = [];
const logger = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
const storage: StorageDriver = {
  name: "fs",
  put: (...args) => real.put(...args),
  get: (key, range) => {
    requested.push(key);
    return real.get(key, range);
  },
  head: (key) => real.head(key),
  delete: (key) => real.delete(key),
  check: () => real.check(),
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-ledger-media-"));
  real = createFsDriver(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Seen = { served: { text: string; alt: string | null } } | { refused: string };
// Reads every position the way an adapter does and records what it got; the publish then goes on as the fixture's.
function readingAdapter(positions: number, seen: Seen[], base: ProviderAdapter): ProviderAdapter {
  return {
    ...base,
    prepare: async (context: AdapterContext, input: CommitInput) => {
      const reader = context.media;
      if (reader === undefined) throw new Error("the context has no media reader");
      for (let position = 0; position < positions; position++) {
        try {
          const medium = await reader.read(position);
          seen.push({ served: { text: Buffer.from(medium.bytes).toString(), alt: medium.altText } });
        } catch (error) {
          seen.push({ refused: `${String(error)} ${error instanceof Error ? (error.stack ?? "") : ""}` });
        }
      }
      return base.prepare(context, input);
    },
  };
}

const turnWith = (e: Env) => {
  const options = {
    pool: workerPool(),
    logger,
    registry: e.registry,
    adapters: e.adapters,
    fetchFor: e.fetchFor,
    credentials: e.credentials,
    queue: e.queueName,
    owner: "owner-w",
    closing: new AbortController().signal,
    storage,
  };
  return runTurn(options);
};

const GOOD: Pin = { stored: "reader-good-bytes-0", alt: "reader good alt 0" };
// [case, the pin at position 1, what position 1 gives]
const PINS: [string, Pin, "served" | "refused"][] = [
  ["a pinned derivative is served with its alt text", { stored: "reader-bytes-1", alt: "alt 1" }, "served"],
  [
    "bytes that changed after the pin are refused",
    { stored: "changed-bytes", pinned: "pinned-bytes" },
    "refused",
  ],
  [
    "a size different from the pinned derivative is refused",
    { stored: "sized-bytes", rowSize: 3 },
    "refused",
  ],
  [
    "a pin without a derivative is refused and the original is never read",
    { stored: "no-derivative", noDerivative: true },
    "refused",
  ],
];
describe("the media reader serves only the held operation's pins (floor)", () => {
  it.each(PINS)(
    "%s",
    async (_name, pin, expected) => {
      const e = await makeEnv();
      const seen: Seen[] = [];
      try {
        e.adapters[e.providerId] = readingAdapter(3, seen, createFixtureAdapter({ baseUrl: e.sim.url }));
        const other = await plant(e);
        await pinMedia(storage, other, [{ stored: "another-operation-bytes-0" }]);
        await rows("UPDATE app.operations SET next_attempt_at = now() + interval '1 day' WHERE id = $1", [
          other,
        ]);
        const id = await plant(e);
        const { originals } = await pinMedia(storage, id, [GOOD, pin]);
        requested.length = 0;
        await turnWith(e);
        // Position 0 is good, position 1 is the case, position 2 is not pinned at all.
        expect(seen[0]).toEqual({ served: { text: GOOD.stored, alt: GOOD.alt } });
        if (expected === "served") expect(seen[1]).toEqual({ served: { text: pin.stored, alt: pin.alt } });
        else expect(seen[1]).toHaveProperty("refused");
        expect(seen[2]).toHaveProperty("refused");
        for (const original of originals) expect(requested).not.toContain(original);
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});

const TOKEN = "ledger-token-canary-1";
const ALT = "ledger alt canary-1 نص بديل";
const BYTES = "ledger-bytes-canary-1";
// [case, what the stored object holds against the pin, the status the provider answers the post with]
const SCENARIOS: [string, string | undefined, number | undefined][] = [
  ["a medium served and the post published", undefined, undefined],
  ["bytes that changed after the pin", "ledger-changed-canary-1", undefined],
  ["the provider refuses the post", undefined, 500],
];
describe("no secret reaches a log, a result or an error (floor)", () => {
  it.each(SCENARIOS)(
    "%s: the token, the alt text and the bytes are in none of them, in any encoding",
    async (_name, changed, status) => {
      const e = await makeEnv();
      const seen: Seen[] = [];
      const before = lines.length;
      try {
        e.adapters[e.providerId] = readingAdapter(1, seen, createFixtureAdapter({ baseUrl: e.sim.url }));
        const id = await plant(e, { token: TOKEN });
        await pinMedia(storage, id, [{ stored: changed ?? BYTES, pinned: BYTES, alt: ALT }]);
        if (status !== undefined) e.sim.arm("commit", { kind: "respond", status });
        const result = await turnWith(e);
        const attempts = await rows(
          `SELECT row_to_json(a)::text AS t FROM app.operation_attempts a WHERE operation_id = $1
           UNION ALL SELECT row_to_json(x)::text FROM app.outbox x WHERE x.payload ->> 'operation_id' = $1::text
           UNION ALL SELECT row_to_json(o)::text FROM app.operations o WHERE o.id = $1`,
          [id],
        );
        const haystack = [
          JSON.stringify(result),
          ...lines.slice(before),
          ...seen.flatMap((one) => ("refused" in one ? [one.refused] : [])),
          ...attempts.map((row) => String(row.t)),
        ];
        expect(seen).toHaveLength(1);
        expect(leaks(haystack.join("\n"), [TOKEN, ALT, BYTES, "ledger-changed-canary-1"])).toEqual([]);
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});
