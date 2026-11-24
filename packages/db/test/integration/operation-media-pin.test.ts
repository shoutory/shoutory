import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, digestOf, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin((client) => seedMembers(client));
});
afterAll(() => db.drop());

const job = (workspaces: string[]): TenantCtx => ({
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: workspaces,
});
const LEDGER: TenantCtx = { principalKind: "job", principalId: randomUUID(), jobPurpose: "ledger" };
const LEASE = { margin_seconds: 300, lease_seconds: { publish: 60, edit: 60, delete: 60 } };

interface Medium {
  id: string;
  sha256: string;
  derivativeId: string | null;
  derivativeSha256: string | null;
}
interface PlantedMedium {
  /** `video/mp4` plants a video, which has no derivative; anything else is an image with a `stripped` copy. */
  mime?: string;
  stripped?: boolean;
  ageDays?: number;
}
async function plantMedium(o: PlantedMedium = {}): Promise<Medium> {
  const [id, ws, mime] = [randomUUID(), WA, o.mime ?? "image/png"];
  const sha = digestOf(id);
  await rows(
    `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, created_by, state, sha256,
       created_at, deleted_at)
     VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'pin.png', $3, 'upload',
       $4::uuid, 'ready', $5, now() - make_interval(secs => $6::float8 * 86400), NULL)`,
    [id, ws, mime, U.editor, sha, o.ageDays ?? 0],
  );
  let derivative: { id: string; sha: Buffer } | undefined;
  if (!mime.startsWith("video/") && o.stripped !== false) {
    const dsha = digestOf(`${id}-stripped`);
    const made = await rows(
      `INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key, state, sha256, byte_size)
       VALUES ($1::uuid, $2::uuid, 'stripped', 'ws/' || $1::text || '/' || $2::text || '/1/stripped', 'ready', $3, 5)
       RETURNING id`,
      [ws, id, dsha],
    );
    derivative = { id: made[0]?.id as string, sha: dsha };
  }
  return {
    id,
    sha256: sha.toString("hex"),
    derivativeId: derivative?.id ?? null,
    derivativeSha256: derivative?.sha.toString("hex") ?? null,
  };
}

interface Target {
  media: Medium[];
  /** The media of another channel's variant in the same snapshot, which this operation must not pin. */
  elsewhere?: Medium[];
  /** Seconds ago the target fell due: 30 is within the two-hour tolerance, 3 hours is late. */
  dueAgo?: number;
  /** The snapshot spells the channel id in upper case, which a guid may be. */
  upperCaseChannel?: boolean;
}
interface Planted {
  provider: string;
  channel: string;
  variant: string;
  version: string;
}
const variantOf = (channel: string, media: Medium[]) => ({
  channel_id: channel,
  locale: null,
  post_type: "text",
  text: "pin",
  parts: [],
  settings: {},
  media: media.map((m) => ({ media_id: m.id, alt_text: null, crop: null })),
});
async function plantTarget(o: Target): Promise<Planted> {
  const provider = `pin-${randomUUID().slice(0, 8)}`;
  const channelOf = async () =>
    (
      await rows(
        `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
         VALUES ($1, $2, 'profile', $3, $3, 'connected') RETURNING id`,
        [WA, provider, randomUUID()],
      )
    )[0]?.id as string;
  const [channel, other] = [await channelOf(), o.elsewhere ? await channelOf() : undefined];
  const post = (
    await rows(
      "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
      [WA, U.editor],
    )
  )[0]?.id as string;
  const everything = [...o.media, ...(o.elsewhere ?? [])];
  const snapshot = {
    version: 1,
    draft: {
      variants: [
        variantOf(o.upperCaseChannel ? channel.toUpperCase() : channel, o.media),
        ...(other ? [variantOf(other, o.elsewhere ?? [])] : []),
      ],
    },
    resolved: {
      variants: [{ channel_id: channel, locale: null, settings: {} }],
      media: Object.fromEntries(everything.map((m) => [m.id, m.sha256])),
      manifestDigest: {},
    },
  };
  const version = (
    await rows(
      `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
       VALUES ($1, $2, 1, 'scheduled', $3::jsonb, decode(repeat('ab', 32), 'hex'), $4) RETURNING id`,
      [WA, post, JSON.stringify(snapshot), U.editor],
    )
  )[0]?.id as string;
  const variant = (
    await rows(
      `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, due_at, frozen_version_id)
       VALUES ($1, $2, $3, 'scheduled', now() - make_interval(secs => $4::float8), $5) RETURNING id`,
      [WA, post, channel, o.dueAgo ?? 30, version],
    )
  )[0]?.id as string;
  return { provider, channel, variant, version };
}

const admitSql = "SELECT * FROM app.admit_due_targets(100, $1::jsonb)";
async function admit(provider: string): Promise<void> {
  const client = await openTx(db.pool("worker"), LEDGER);
  try {
    await client.query(admitSql, [JSON.stringify({ [provider]: LEASE })]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}
const outcomeOf = async (variant: string) => ({
  schedule: (await rows("SELECT schedule_state FROM app.post_variants WHERE id = $1", [variant]))[0]
    ?.schedule_state as string,
  operations: (await rows("SELECT state FROM app.operations WHERE variant_id = $1", [variant])).map(
    (row) => row.state as string,
  ),
});
const pinsOf = async (variant: string) =>
  (
    await rows(
      `SELECT m.position::int AS position, m.media_id, m.derivative_id, encode(m.derivative_sha256, 'hex') AS sha256
       FROM app.operation_media AS m JOIN app.operations AS o ON o.workspace_id = m.workspace_id AND o.id = m.operation_id
       WHERE o.variant_id = $1 ORDER BY o.created_at, m.position`,
      [variant],
    )
  ).map((row) => ({
    position: row.position,
    media_id: row.media_id,
    derivative_id: row.derivative_id,
    sha256: row.sha256,
  }));
const pinOf = (m: Medium, position: number) => ({
  position,
  media_id: m.id,
  derivative_id: m.derivativeId,
  sha256: m.derivativeSha256 ?? m.sha256,
});

async function take(asset: string): Promise<string[]> {
  const client = await openTx(db.pool("worker"), job([WA]));
  try {
    const found = (
      await client.query("SELECT object_key FROM app.media_gc_take($1, $2, 'unreferenced')", [WA, asset])
    ).rows;
    await client.query("COMMIT");
    return found.map((row) => row.object_key as string);
  } finally {
    client.release();
  }
}
async function collectable(asset: string): Promise<boolean> {
  const client = await openTx(db.pool("worker"), job([WA]));
  try {
    const found = await client.query("SELECT asset_id FROM app.media_gc_candidates(500)");
    return found.rows.some((row) => row.asset_id === asset);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
// Plants a state on an operation with the triggers off, as earlier moves would have left it.
const setState = (operation: string, state: string, effect = "none") =>
  admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("UPDATE app.operations SET state = $2, effect = $3 WHERE id = $1", [
      operation,
      state,
      effect,
    ]);
    await client.query("COMMIT");
  });
const operationOf = async (variant: string) =>
  (
    await rows("SELECT id FROM app.operations WHERE variant_id = $1 ORDER BY created_at LIMIT 1", [variant])
  )[0]?.id as string;

describe("media pinned by an operation is never collected while the operation can still send it (floor)", () => {
  it("is kept from the candidate list and the take, and is offered again once the operation has published", async () => {
    const medium = await plantMedium({ ageDays: 31 });
    const target = await plantTarget({ media: [medium] });
    expect(await collectable(medium.id)).toBe(true);
    await admit(target.provider);
    expect(await outcomeOf(target.variant)).toMatchObject({ operations: ["pending"] });
    expect(await collectable(medium.id)).toBe(false);
    expect(await take(medium.id)).toEqual([]);
    await setState(await operationOf(target.variant), "published", "confirmed");
    expect(await collectable(medium.id)).toBe(true);
    expect((await take(medium.id)).length).toBeGreaterThan(0);
  });
});

type Pinned = { target: Target; operations: string[]; pins: ReturnType<typeof pinOf>[] };
const PINNED: [string, () => Promise<Pinned>][] = [
  [
    "an image: the id and the hash of its ready stripped copy",
    async () => {
      const image = await plantMedium();
      return { target: { media: [image] }, operations: ["pending"], pins: [pinOf(image, 0)] };
    },
  ],
  [
    "a video: no derivative, and the hash of the original",
    async () => {
      const video = await plantMedium({ mime: "video/mp4" });
      return { target: { media: [video] }, operations: ["pending"], pins: [pinOf(video, 0)] };
    },
  ],
  [
    "two media, in the order the post lists them and not the order of their ids",
    async () => {
      const media = await Promise.all([plantMedium(), plantMedium({ mime: "video/mp4" }), plantMedium()]);
      const listed = [...media].sort((a, b) => (a.id < b.id ? 1 : -1));
      return {
        target: { media: listed },
        operations: ["pending"],
        pins: listed.map((m, at) => pinOf(m, at)),
      };
    },
  ],
  [
    "only the media of its own channel's variant, not another channel's in the same snapshot",
    async () => {
      const [mine, theirs] = [await plantMedium(), await plantMedium()];
      return {
        target: { media: [mine], elsewhere: [theirs] },
        operations: ["pending"],
        pins: [pinOf(mine, 0)],
      };
    },
  ],
  [
    "a snapshot that spells the channel id in upper case still pins its media",
    async () => {
      const image = await plantMedium();
      return {
        target: { media: [image], upperCaseChannel: true },
        operations: ["pending"],
        pins: [pinOf(image, 0)],
      };
    },
  ],
  [
    "nothing for an operation that was missed, which sends nothing",
    async () => ({
      target: { media: [await plantMedium()], dueAgo: 3 * 3600 },
      operations: ["missed"],
      pins: [],
    }),
  ],
];
describe("what an operation pins (floor)", () => {
  it.each(PINNED)("%s", async (_what, build) => {
    const { target: wanted, operations, pins } = await build();
    const target = await plantTarget(wanted);
    await admit(target.provider);
    expect((await outcomeOf(target.variant)).operations).toEqual(operations);
    expect(await pinsOf(target.variant)).toEqual(pins);
  });
});

describe("a medium that is not ready at admission leaves the target scheduled, and the batch goes on (floor)", () => {
  const BAD: [string, () => Promise<Medium>][] = [
    ["ready with no stripped copy", () => plantMedium({ stripped: false })],
  ];
  it.each(BAD)("%s", async (_what, bad) => {
    const [alongside, fine] = [await plantMedium(), await plantMedium()];
    const unready = await bad();
    const [first, second] = [
      await plantTarget({ media: [alongside, unready] }),
      await plantTarget({ media: [fine] }),
    ];
    // One provider for both, so one admission call sees them together.
    await rows("UPDATE app.channels SET provider_id = $2 WHERE id = $1", [second.channel, first.provider]);
    await admit(first.provider);
    expect(await outcomeOf(first.variant)).toEqual({ schedule: "scheduled", operations: [] });
    expect(await pinsOf(first.variant)).toEqual([]);
    expect(await outcomeOf(second.variant)).toMatchObject({ operations: ["pending"] });
    expect(await pinsOf(second.variant)).toEqual([pinOf(fine, 0)]);
  });
});

// How long a writer of a race has to be seen waiting: well under the 5 s limit of a test, so that a writer that never
// waits fails with the lock-wait error and not with the test's timeout.
const WAIT_MS = 3_000;
async function untilWaiting(count: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const waiting = await rows(
      `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = $1`,
      [db.name],
    );
    if (waiting.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the second writer never waited for the lock");
}

describe("the pin and the collection of one medium are serialized, whichever comes first (race, floor)", () => {
  it("a take that holds the medium makes admission wait, and then leave the target scheduled with no operation and no pin", async () => {
    const medium = await plantMedium({ ageDays: 31 });
    const target = await plantTarget({ media: [medium] });
    const result = await holdThenRace(
      rows,
      await openTx(db.pool("worker"), job([WA])),
      await openTx(db.pool("worker"), LEDGER),
      async (client, n) => {
        if (n === 1)
          await client.query("SELECT object_key FROM app.media_gc_take($1, $2, 'unreferenced')", [
            WA,
            medium.id,
          ]);
        else await client.query(admitSql, [JSON.stringify({ [target.provider]: LEASE })]);
      },
      WAIT_MS,
    );
    expect(result.secondError).toBeUndefined();
    expect(await outcomeOf(target.variant)).toEqual({ schedule: "scheduled", operations: [] });
    expect(await pinsOf(target.variant)).toEqual([]);
    expect((await rows("SELECT state FROM app.media_assets WHERE id = $1", [medium.id]))[0]?.state).toBe(
      "deleted",
    );
  });

  it("an admission that holds the pin makes the take wait, and then take nothing", async () => {
    const medium = await plantMedium({ ageDays: 31 });
    const target = await plantTarget({ media: [medium] });
    const taken: Record<number, string[]> = {};
    const result = await holdThenRace(
      rows,
      await openTx(db.pool("worker"), LEDGER),
      await openTx(db.pool("worker"), job([WA])),
      async (client, n) => {
        if (n === 1) await client.query(admitSql, [JSON.stringify({ [target.provider]: LEASE })]);
        else
          taken[n] = (
            await client.query("SELECT object_key FROM app.media_gc_take($1, $2, 'unreferenced')", [
              WA,
              medium.id,
            ])
          ).rows.map((row) => row.object_key as string);
      },
      WAIT_MS,
    );
    expect(result.secondError).toBeUndefined();
    expect(taken[2]).toEqual([]);
    expect(await pinsOf(target.variant)).toEqual([pinOf(medium, 0)]);
    expect((await rows("SELECT state FROM app.media_assets WHERE id = $1", [medium.id]))[0]?.state).toBe(
      "ready",
    );
  });
});

describe("a post attach joins the race of the pin and the collection (race, floor)", () => {
  it("a take, an admission and a post attach meeting on one medium end with the medium deleted, the target scheduled and the attach refused", async () => {
    const medium = await plantMedium({ ageDays: 31 });
    const target = await plantTarget({ media: [medium] });
    const taker = await openTx(db.pool("worker"), job([WA]));
    const admitter = await openTx(db.pool("worker"), LEDGER);
    let admitted: Promise<unknown> = Promise.resolve();
    let attachError: unknown;
    try {
      await taker.query("SELECT object_key FROM app.media_gc_take($1, $2, 'unreferenced')", [WA, medium.id]);
      admitted = admitter.query(admitSql, [JSON.stringify({ [target.provider]: LEASE })]).then(
        () => admitter.query("COMMIT"),
        (error: unknown) => error,
      );
      attachError = await admin(async (client) => {
        const result = client
          .query(
            "INSERT INTO app.post_media (workspace_id, variant_id, position, media_id) VALUES ($1, $2, 0, $3)",
            [WA, target.variant, medium.id],
          )
          .catch((error: unknown) => error);
        await untilWaiting(2);
        await taker.query("COMMIT");
        return result;
      });
      expect(await admitted).not.toBeInstanceOf(Error);
    } finally {
      await taker.query("ROLLBACK").catch(() => undefined);
      await admitted;
      taker.release();
      admitter.release();
    }
    expect(attachError).toMatchObject({ code: "SH422" });
    expect(await outcomeOf(target.variant)).toEqual({ schedule: "scheduled", operations: [] });
    expect(await rows("SELECT 1 FROM app.post_media WHERE media_id = $1", [medium.id])).toEqual([]);
    expect((await rows("SELECT state FROM app.media_assets WHERE id = $1", [medium.id]))[0]?.state).toBe(
      "deleted",
    );
  });
});

async function plantOperation(target: Planted, state: string, effect: string): Promise<string> {
  await rows("UPDATE app.post_variants SET schedule_state = 'in_progress' WHERE id = $1", [target.variant]);
  return admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const made = await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect, last_actor,
         due_at, lateness_deadline, idempotency_marker, requested_by, frozen_version_id, frozen_snapshot_hash)
       VALUES ($1, $2, $3, $4, 'publish.pin', 'publish', $5, $6, 'S', now(), now() + interval '2 hours', $7, $8, $9,
         decode(repeat('ab', 32), 'hex')) RETURNING id`,
      [
        WA,
        target.variant,
        target.channel,
        target.provider,
        state,
        effect,
        `pin-${randomUUID()}`,
        U.editor,
        target.version,
      ],
    );
    await client.query("COMMIT");
    return made.rows[0].id as string;
  });
}
async function resolve(operation: string, kind: string) {
  const client = await openTx(db.pool("app"), asUser(U.owner));
  try {
    const answer = await client.query("SELECT * FROM app.resolve_operation($1, $2, $3, $4::jsonb)", [
      WA,
      operation,
      kind,
      JSON.stringify(kind === "supersede" ? { ack_text: "sent by hand" } : {}),
    ]);
    await client.query("COMMIT");
    return { rows: answer.rows as Record<string, unknown>[], error: undefined };
  } catch (error) {
    return { rows: undefined, error: error as { code?: string; message?: string } };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

describe("a resolution that sends again pins like admission, and refuses a medium that is no longer ready (floor)", () => {
  const SENDS: [string, string, string, string][] = [
    ["supersede", "needs_human", "possible", "an operation that needs a person"],
    ["publish_late", "missed", "none", "a missed operation"],
  ];
  it.each(SENDS)("%s of %s pins the same media from the frozen snapshot", async (kind, state, effect) => {
    const media = [await plantMedium(), await plantMedium({ mime: "video/mp4" })];
    const target = await plantTarget({ media });
    const operation = await plantOperation(target, state, effect);
    const answer = await resolve(operation, kind);
    expect(answer.error).toBeUndefined();
    const made = (answer.rows?.[0] as { new_operation_id: string } | undefined)?.new_operation_id;
    expect(made).toBeDefined();
    const pinned = await rows(
      `SELECT position::int AS position, media_id, derivative_id, encode(derivative_sha256, 'hex') AS sha256
       FROM app.operation_media WHERE operation_id = $1 ORDER BY position`,
      [made],
    );
    expect(pinned).toEqual(media.map((m, at) => pinOf(m, at)));
  });

  it.each(SENDS)(
    "%s with a medium that was deleted since inserts no operation, no pin and no resolution",
    async (kind, state, effect) => {
      const media = [await plantMedium()];
      const target = await plantTarget({ media });
      const operation = await plantOperation(target, state, effect);
      await rows("UPDATE app.media_assets SET state = 'deleted', deleted_at = now() WHERE id = $1", [
        media[0]?.id,
      ]);
      const answer = await resolve(operation, kind);
      expect(answer.error).toMatchObject({ code: "SH422", message: "resolve_operation: media_unavailable" });
      expect(await rows("SELECT state FROM app.operations WHERE id = $1", [operation])).toEqual([{ state }]);
      expect(
        (await rows("SELECT id FROM app.operations WHERE variant_id = $1", [target.variant])).length,
      ).toBe(1);
      expect(
        await rows("SELECT 1 FROM app.operation_media WHERE workspace_id = $1 AND media_id = $2", [
          WA,
          media[0]?.id,
        ]),
      ).toEqual([]);
      expect(
        await rows("SELECT 1 FROM app.operation_resolutions WHERE operation_id = $1", [operation]),
      ).toEqual([]);
    },
  );
});

describe("who may write a pin (floor)", () => {
  // The lock and the writer of the pin, whatever the order of their arguments: neither is callable by a runtime role.
  const HELPERS = [
    "SELECT app.operation_media_lock($1, $2, $3)",
    "SELECT app.operation_media_pin($1, $2, $3)",
  ];
  const REFUSED: [string, "app" | "worker", TenantCtx][] = [
    ["a user", "app", asUser(U.owner)],
    ["a job of the workspace", "worker", job([WA])],
    ["a job of another workspace", "worker", job([WB])],
  ];
  it.each(REFUSED)("%s may not call the lock or the pin writer", async (_who, pool, ctx) => {
    for (const sql of HELPERS) {
      const answer = await attempt(db.pool(pool), ctx, sql, [WA, randomUUID(), randomUUID()]);
      expect(answer.error, sql).toMatchObject({ code: "42501" });
    }
  });
});
