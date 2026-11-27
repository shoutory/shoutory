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
import { asUser, seedMembers, U, WA } from "../support/members-seed.js";
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

async function exec(ctx: TenantCtx, pool: "worker" | "app", sql: string, params: unknown[] = []) {
  const client = await openTx(db.pool(pool), ctx);
  try {
    const answer = await client.query(sql, params);
    await client.query("COMMIT");
    return {
      rows: answer.rows,
      rowCount: answer.rowCount,
      error: undefined as { code?: string } | undefined,
    };
  } catch (error) {
    return { rows: [], rowCount: 0, error: error as { code?: string } };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

interface Provider {
  id: string;
  channel: string;
}
async function provider(): Promise<Provider> {
  const id = `prio-${randomUUID().slice(0, 8)}`;
  const [made] = await rows(
    `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
     VALUES ($1, $2, 'profile', $2, $2, 'connected') RETURNING id`,
    [WA, id],
  );
  return { id, channel: made?.id as string };
}

// A pending operation as admission leaves it; `ageMinutes` is how long it has waited.
async function pending(p: Provider, o: { priority: boolean; ageMinutes: number }): Promise<string> {
  return admin(async (client) => {
    const post = await client.query(
      "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
      [WA, U.editor],
    );
    const version = await client.query(
      `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
       VALUES ($1, $2, 1, 'scheduled', '{"version":1}'::jsonb, decode(repeat('ab', 32), 'hex'), $3) RETURNING id`,
      [WA, post.rows[0].id, U.editor],
    );
    const variant = await client.query(
      `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, frozen_version_id, due_at)
       VALUES ($1, $2, $3, 'in_progress', $4, now() - make_interval(mins => $5)) RETURNING id`,
      [WA, post.rows[0].id, p.channel, version.rows[0].id, o.ageMinutes],
    );
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const op = await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect,
         last_actor, due_at, next_attempt_at, lateness_deadline, idempotency_marker, frozen_version_id,
         frozen_snapshot_hash, requested_by, lease_seconds, fencing_token, priority)
       VALUES ($1, $2, $3, $4, 'publish.' || $4, 'publish', 'pending', 'none', 'S', now() - make_interval(mins => $5),
         now() - make_interval(mins => $5), now() + interval '2 hours', $6, $7, decode(repeat('ab', 32), 'hex'), $8, 60, 1,
         $9)
       RETURNING id`,
      [
        WA,
        variant.rows[0].id,
        p.channel,
        p.id,
        o.ageMinutes,
        `prio-${randomUUID()}`,
        version.rows[0].id,
        U.editor,
        o.priority,
      ],
    );
    await client.query("COMMIT");
    return op.rows[0].id as string;
  });
}
const claim = async (p: Provider, limit = 1) =>
  (
    await exec(LEDGER, "worker", "SELECT id FROM app.claim_operations($1, $2, 'floor-owner')", [
      `publish.${p.id}`,
      limit,
    ])
  ).rows.map((row) => row.id as string);

describe("claim order", () => {
  it("a publish-now operation is claimed before an older backlog of its own provider", async () => {
    const p = await provider();
    const backlog = await Promise.all(
      [30, 20, 10].map((ageMinutes) => pending(p, { priority: false, ageMinutes })),
    );
    const now = await pending(p, { priority: true, ageMinutes: 1 });
    expect(await claim(p)).toEqual([now]);
    expect(await claim(p, 3)).toEqual(backlog);
  });

  it("without priority the order stays oldest first", async () => {
    const p = await provider();
    const [older, newer] = [
      await pending(p, { priority: false, ageMinutes: 20 }),
      await pending(p, { priority: false, ageMinutes: 5 }),
    ];
    expect(await claim(p, 2)).toEqual([older, newer]);
  });

  it("a stalled provider's backlog never delays another provider's publish-now operation", async () => {
    const [stalled, live] = [await provider(), await provider()];
    await Promise.all([40, 30, 20].map((ageMinutes) => pending(stalled, { priority: false, ageMinutes })));
    const now = await pending(live, { priority: true, ageMinutes: 1 });
    expect(await claim(live)).toEqual([now]);
    expect(await claim(stalled, 1)).toHaveLength(1);
  });

  it("no operation names a shared priority queue", async () => {
    const p = await provider();
    await pending(p, { priority: true, ageMinutes: 1 });
    expect(await rows("SELECT 1 FROM app.operations WHERE queue = 'publish.priority'")).toEqual([]);
    expect((await rows("SELECT queue FROM app.operations WHERE provider_id = $1", [p.id]))[0]?.queue).toBe(
      `publish.${p.id}`,
    );
  });
});

describe("the late-publish window", () => {
  const SECONDS: [number, boolean][] = [
    [0, false],
    [299, false],
    [300, true],
    [7200, true],
    [86_400, true],
    [86_401, false],
  ];
  it.each(SECONDS)("a lateness tolerance of %i seconds is accepted: %s", async (seconds, accepted) => {
    const attempt = admin((client) =>
      client.query("UPDATE app.workspaces SET lateness_tolerance = make_interval(secs => $2) WHERE id = $1", [
        WA,
        seconds,
      ]),
    );
    if (accepted) await expect(attempt).resolves.toBeDefined();
    else await expect(attempt).rejects.toMatchObject({ code: "23514" });
  });

  it("an Admin changes it through the column grant, and an Editor cannot", async () => {
    const change = (user: string) =>
      exec(
        { ...asUser(user), workspaceIds: [WA], writeWorkspaceId: WA },
        "app",
        "UPDATE app.workspaces SET lateness_tolerance = interval '3 hours' WHERE id = $1",
        [WA],
      );
    const control = await exec(
      { ...asUser(U.admin), workspaceIds: [WA], writeWorkspaceId: WA },
      "app",
      "UPDATE app.workspaces SET default_tz = default_tz WHERE id = $1",
      [WA],
    );
    expect([control.error, control.rowCount]).toEqual([undefined, 1]);
    const [admin1, editor] = [await change(U.admin), await change(U.editor)];
    expect([admin1.error, admin1.rowCount]).toEqual([undefined, 1]);
    expect(editor.rowCount).toBe(0);
    expect(
      (
        await rows(
          "SELECT extract(epoch FROM lateness_tolerance)::int AS s FROM app.workspaces WHERE id = $1",
          [WA],
        )
      )[0]?.s,
    ).toBe(10_800);
  });
});
