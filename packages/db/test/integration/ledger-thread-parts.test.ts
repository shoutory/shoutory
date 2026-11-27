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
import { asUser, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

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

const LEDGER: TenantCtx = { principalKind: "job", principalId: randomUUID(), jobPurpose: "ledger" };

interface Provider {
  id: string;
  channel: string;
  workspace: typeof WA;
}
const mapOf = (...providers: Provider[]) =>
  JSON.stringify(
    Object.fromEntries(
      providers.map((p) => [
        p.id,
        { margin_seconds: 300, lease_seconds: { publish: 60, edit: 60, delete: 45 } },
      ]),
    ),
  );
async function provider(workspace = WA): Promise<Provider> {
  const id = `thread-${randomUUID().slice(0, 8)}`;
  const [made] = await rows(
    `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
     VALUES ($1, $2, 'profile', $2, $2, 'connected') RETURNING id`,
    [workspace, id],
  );
  return { id, channel: made?.id as string, workspace };
}

interface Thread {
  variant: string;
  version: string;
  ops: string[];
  p: Provider;
}
interface Planted {
  /** The follow-up parts of the frozen version; the root is part 0. */
  followUps: number;
  /** How many parts, from the root, are published. */
  published: number;
  variantState?: string;
  workspace?: typeof WA;
  presence?: string;
}
async function thread(o: Planted): Promise<Thread> {
  const p = await provider(o.workspace);
  const [post] = await rows(
    "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
    [p.workspace, U.editor],
  );
  const parts = Array.from({ length: o.followUps }, (_, i) => ({
    kind: i === 0 ? "thread_reply" : "first_comment",
    text: `part ${i + 1}`,
  }));
  const snapshot = {
    version: 1,
    draft: {
      variants: [
        {
          channel_id: p.channel,
          locale: null,
          post_type: "text",
          text: "root",
          parts,
          settings: {},
          media: [],
        },
      ],
    },
    resolved: {
      variants: [{ channel_id: p.channel, locale: null, settings: {} }],
      media: {},
      manifestDigest: {},
    },
  };
  const [version] = await rows(
    `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
     VALUES ($1, $2, 1, 'scheduled', $3::jsonb, decode(repeat('ab', 32), 'hex'), $4) RETURNING id`,
    [p.workspace, post?.id, JSON.stringify(snapshot), U.editor],
  );
  const [variant] = await rows(
    `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, frozen_version_id, presence, published_at, external_id)
     VALUES ($1, $2, $3, $4, $5, $6, now(), 'remote-0') RETURNING id`,
    [p.workspace, post?.id, p.channel, o.variantState ?? "in_progress", version?.id, o.presence ?? "present"],
  );
  const t: Thread = { variant: String(variant?.id), version: String(version?.id), ops: [], p };
  for (let part = 0; part < o.published; part++) {
    t.ops.push(await plantOp(t, { kind: "publish", part, state: "published", external: `remote-${part}` }));
  }
  return t;
}

interface PlantedOp {
  kind: "publish" | "delete";
  part: number;
  state: string;
  external?: string;
  dependsOn?: string;
  marker?: string;
}
async function plantOp(t: Thread, o: PlantedOp): Promise<string> {
  const given: Record<string, unknown> = {
    workspace_id: t.p.workspace,
    variant_id: t.variant,
    channel_id: t.p.channel,
    provider_id: t.p.id,
    queue: `publish.${t.p.id}`,
    kind: o.kind,
    part_index: o.part,
    state: o.state,
    effect: ["published", "unknown_external_state"].includes(o.state) ? "confirmed" : "none",
    fencing_token: 1,
    last_actor: "S",
    idempotency_marker: o.marker ?? `plant-${randomUUID()}`,
    requested_by: U.editor,
    lease_seconds: 60,
    frozen_version_id: t.version,
    frozen_snapshot_hash: Buffer.alloc(32, 0xab),
    due_at: new Date(Date.now() - 120_000),
    next_attempt_at: new Date(Date.now() - 60_000),
    lateness_deadline: new Date(Date.now() + 7_200_000),
    ...(o.external === undefined ? {} : { external_id: o.external }),
    ...(o.dependsOn === undefined ? {} : { depends_on_operation_id: o.dependsOn }),
    ...(o.state === "published" ? { settled_at: new Date() } : {}),
  };
  const names = Object.keys(given);
  return admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const made = await client.query(
      `INSERT INTO app.operations (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(given),
    );
    await client.query("COMMIT");
    return made.rows[0].id as string;
  });
}

const opsOf = (variant: string, kind = "publish") =>
  rows(
    `SELECT id, part_index, state, queue, kind, idempotency_marker AS marker, depends_on_operation_id AS parent,
       frozen_version_id AS version, requested_by, lease_seconds, workspace_id, channel_id,
       extract(epoch FROM lateness_deadline - due_at)::int AS window,
       extract(epoch FROM clock_timestamp() - due_at)::int AS age
     FROM app.operations WHERE variant_id = $1 AND kind = $2 ORDER BY part_index, created_at`,
    [variant, kind],
  );
const reservations = async (variant: string) =>
  (
    await rows(
      `SELECT count(*)::int AS n FROM app.usage_reservations r JOIN app.operations o ON o.id = r.operation_id
       WHERE o.variant_id = $1`,
      [variant],
    )
  )[0]?.n;

async function admitOnce(map: string) {
  const client = await openTx(db.pool("worker"), LEDGER);
  try {
    const answer = (await client.query("SELECT * FROM app.admit_due_targets(100, $1::jsonb)", [map])).rows;
    await client.query("COMMIT");
    return answer;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function admitRacing(map: string) {
  const first = await openTx(db.pool("worker"), LEDGER);
  const second = await openTx(db.pool("worker"), LEDGER);
  try {
    const query = "SELECT * FROM app.admit_due_targets(100, $1::jsonb)";
    const mine = (await first.query(query, [map])).rows;
    const racing = (await second.query(query, [map])).rows;
    await first.query("COMMIT");
    await second.query("COMMIT");
    return { mine, racing };
  } finally {
    for (const client of [first, second]) {
      await client.query("ROLLBACK");
      client.release();
    }
  }
}

describe("part n+1 of a thread (floor)", () => {
  it("is inserted once from the frozen version when part n is published, and two concurrent admissions insert one row", async () => {
    const t = await thread({ followUps: 2, published: 1 });
    const { mine, racing } = await admitRacing(mapOf(t.p));
    expect(mine).toHaveLength(1);
    expect(racing).toEqual([]);
    const made = await opsOf(t.variant);
    expect(made.map((op) => [op.part_index, op.state])).toEqual([
      [0, "published"],
      [1, "pending"],
    ]);
    expect(made[1]).toMatchObject({
      parent: t.ops[0],
      marker: `part-${t.ops[0]}-1`,
      version: t.version,
      queue: `publish.${t.p.id}`,
      requested_by: U.editor,
      workspace_id: WA,
      channel_id: t.p.channel,
    });
    expect(made[1]).toMatchObject({ window: 7200, age: expect.any(Number) });
    expect(Number(made[1]?.age)).toBeLessThan(30);
    expect(await reservations(t.variant)).toBe(0);
    expect(await admitOnce(mapOf(t.p))).toEqual([]);
    expect(await opsOf(t.variant)).toHaveLength(2);
  });

  it("is not inserted for the version the variant holds now: the count is the one the root was published with", async () => {
    const t = await thread({ followUps: 1, published: 2 });
    await rows("UPDATE app.post_variants SET parts = $2::jsonb WHERE id = $1", [
      t.variant,
      JSON.stringify([{ kind: "thread_reply", text: "added after the freeze" }]),
    ]);
    expect(await admitOnce(mapOf(t.p))).toEqual([]);
    expect(await opsOf(t.variant)).toHaveLength(2);
  });
});

describe("a part that did not publish stops its thread (floor)", () => {
  it.each([
    ["is live", "pending", "in_progress"],
    ["failed", "failed", "settled"],
    ["failed while the variant still shows in_progress", "failed", "in_progress"],
    ["needs a person", "needs_human", "held"],
    ["is unknown", "unknown_external_state", "in_progress"],
  ])("never gets part 2 while part 1 %s, and part 1 is never inserted twice", async (_name, state, shown) => {
    const t = await thread({ followUps: 2, published: 1, variantState: shown });
    await plantOp(t, {
      kind: "publish",
      part: 1,
      state,
      marker: `part-${t.ops[0]}-1`,
      dependsOn: t.ops[0] as string,
    });
    expect(await admitOnce(mapOf(t.p))).toEqual([]);
    expect((await opsOf(t.variant)).map((op) => [op.part_index, op.state])).toEqual([
      [0, "published"],
      [1, state],
    ]);
  });

  it("is inserted in the workspace of its variant for every workspace at once", async () => {
    const own = await thread({ followUps: 1, published: 1 });
    const other = await thread({ followUps: 1, published: 1, workspace: WB });
    const answer = await admitOnce(mapOf(own.p, other.p));
    expect(answer).toHaveLength(2);
    const [mine, theirs] = [await opsOf(own.variant), await opsOf(other.variant)];
    expect([mine[1]?.workspace_id, mine[1]?.channel_id]).toEqual([WA, own.p.channel]);
    expect([theirs[1]?.workspace_id, theirs[1]?.channel_id]).toEqual([WB, other.p.channel]);
  });
});

async function requested(parts: number, first = "published") {
  const t = await thread({
    followUps: parts - 1,
    published: parts,
    variantState: "settled",
    presence: "removal_pending",
  });
  const top = await plantOp(t, { kind: "delete", part: parts - 1, state: first });
  return { t, top };
}

describe("the delete of a thread (floor)", () => {
  it("inserts the delete of the next lower part once, when a part's delete is published, even with two admissions at once", async () => {
    const { t, top } = await requested(3);
    const { mine, racing } = await admitRacing(mapOf(t.p));
    expect(mine).toHaveLength(1);
    expect(racing).toEqual([]);
    const made = await opsOf(t.variant, "delete");
    expect(made.map((op) => [op.part_index, op.state])).toEqual([
      [1, "pending"],
      [2, "published"],
    ]);
    expect(made[0]).toMatchObject({
      parent: top,
      marker: `delete-${top}-1`,
      version: t.version,
      queue: `publish.${t.p.id}`,
      lease_seconds: 45,
    });
    expect(await reservations(t.variant)).toBe(0);
    expect(await admitOnce(mapOf(t.p))).toEqual([]);
  });

  it("is inserted in the workspace of its variant for every workspace at once", async () => {
    const own = (await requested(2)).t;
    const other = await thread({
      followUps: 1,
      published: 2,
      variantState: "settled",
      presence: "removal_pending",
      workspace: WB,
    });
    await plantOp(other, { kind: "delete", part: 1, state: "published" });
    expect(await admitOnce(mapOf(own.p, other.p))).toHaveLength(2);
    const [mine, theirs] = [await opsOf(own.variant, "delete"), await opsOf(other.variant, "delete")];
    expect([mine[0]?.workspace_id, mine[0]?.channel_id]).toEqual([WA, own.p.channel]);
    expect([theirs[0]?.workspace_id, theirs[0]?.channel_id]).toEqual([WB, other.p.channel]);
  });
});

describe("the delete chain ends and stops (floor)", () => {
  it.each([
    ["needs a person", "needs_human"],
    ["is unknown", "unknown_external_state"],
    ["failed", "failed"],
    ["is still being sent", "pending"],
  ])("sends nothing further when the delete of a part %s", async (_name, state) => {
    const { t } = await requested(3, state);
    expect(await admitOnce(mapOf(t.p))).toEqual([]);
    expect(await opsOf(t.variant, "delete")).toHaveLength(1);
  });
});

async function confirmRemoved(operation: string): Promise<void> {
  const client = await openTx(db.pool("app"), asUser(U.owner));
  try {
    await client.query(
      "SELECT * FROM app.resolve_operation($1::uuid, $2::uuid, 'confirm_removed', '{}'::jsonb)",
      [WA, operation],
    );
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
const presenceOf = async (variant: string) =>
  (await rows("SELECT presence FROM app.post_variants WHERE id = $1", [variant]))[0]?.presence;

describe("a person confirms the removal of a part (floor)", () => {
  it("lets the chain go on from a part above the root, and only the root's confirmation reports the post removed", async () => {
    const { t, top } = await requested(2, "needs_human");
    await confirmRemoved(top);
    expect(await presenceOf(t.variant)).toBe("removal_pending");
    expect(await admitOnce(mapOf(t.p))).toHaveLength(1);
    const [root] = await opsOf(t.variant, "delete");
    expect(root).toMatchObject({ part_index: 0, state: "pending" });
    await admin(async (client) => {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("UPDATE app.operations SET state = 'needs_human' WHERE id = $1", [root?.id]);
      await client.query("COMMIT");
    });
    await confirmRemoved(String(root?.id));
    expect(await presenceOf(t.variant)).toBe("removal_reported");
  });
});

describe("a follow-up that can never be inserted ends its chain (floor)", () => {
  it("settles the thread as partially published when its provider is not registered, with the refusal reported once", async () => {
    const t = await thread({ followUps: 2, published: 1 });
    expect(await admitOnce("{}")).toEqual([
      expect.objectContaining({ state: "refused", reason: "provider_unavailable", variant_id: t.variant }),
    ]);
    expect((await opsOf(t.variant)).map((op) => [op.part_index, op.state])).toEqual([
      [0, "published"],
      [1, "missed"],
    ]);
    const [shown] = await rows(
      `SELECT v.schedule_state, p.status FROM app.post_variants v JOIN app.posts p ON p.id = v.post_id WHERE v.id = $1`,
      [t.variant],
    );
    expect(shown).toEqual({ schedule_state: "settled", status: "partially_published" });
    expect(await admitOnce("{}")).toEqual([]);
  });

  it("settles a thread delete as removal_unknown when its provider is not registered", async () => {
    const { t } = await requested(3);
    expect(await admitOnce("{}")).toEqual([
      expect.objectContaining({ state: "refused", reason: "provider_unavailable", variant_id: t.variant }),
    ]);
    expect((await opsOf(t.variant, "delete")).map((op) => [op.part_index, op.state])).toEqual([
      [1, "missed"],
      [2, "published"],
    ]);
    expect(await presenceOf(t.variant)).toBe("removal_unknown");
    expect(await admitOnce("{}")).toEqual([]);
  });
});
