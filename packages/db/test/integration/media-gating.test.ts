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
import { asUser, digestOf, seedMembers, U, WA, WB } from "../support/members-seed.js";
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

async function plantAsset(state: string, ws: string = WA, sha: Buffer | null = null): Promise<string> {
  const id = randomUUID();
  await rows(
    `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by, state, sha256, deleted_at)
     VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'gate.png', 'upload',
       $3::uuid, $4::text, $5, CASE WHEN $4::text = 'deleted' THEN now() END)`,
    [id, ws, U.editor, state, sha ?? (state === "pending_upload" ? null : digestOf(id))],
  );
  return id;
}

describe("completing an upload leaves one media.uploaded event (the trigger of the pipeline)", () => {
  const complete = async (asset: string, sha: Buffer, commit: boolean) => {
    const client = await openTx(db.pool("app"), asUser(U.editor));
    try {
      const answer = (
        await client.query("SELECT * FROM app.media_mark_uploaded($1, $2, $3, 1024, 'image/png')", [
          WA,
          asset,
          sha,
        ])
      ).rows[0];
      await client.query(commit ? "COMMIT" : "ROLLBACK");
      return answer as { outcome: string };
    } finally {
      client.release();
    }
  };
  const eventsOf = (asset: string) =>
    rows("SELECT workspace_id, type, payload FROM app.outbox WHERE payload->>'media_id' = $1", [asset]);

  it("writes one row in the same transaction, none when it rolls back, and none for a duplicate", async () => {
    const sha = digestOf(`gating-${randomUUID()}`);
    const done = await plantAsset("pending_upload");
    expect((await complete(done, sha, true)).outcome).toBe("ok");
    expect(await eventsOf(done)).toEqual([
      { workspace_id: WA, type: "media.uploaded", payload: { media_id: done } },
    ]);
    const rolledBack = await plantAsset("pending_upload");
    await complete(rolledBack, digestOf(`gating-${randomUUID()}`), false);
    expect(await eventsOf(rolledBack)).toEqual([]);
    const fresh = await plantAsset("pending_upload");
    expect((await complete(fresh, sha, true)).outcome).toBe("duplicate");
    expect(await eventsOf(fresh)).toEqual([]);
  });
});

const LEDGER: TenantCtx = { principalKind: "job", principalId: randomUUID(), jobPurpose: "ledger" };
const LEASE = { margin_seconds: 300, lease_seconds: { publish: 60, edit: 60, delete: 60 } };

interface Target {
  /** The ids the frozen snapshot lists; a state plants an asset of that state in WA. */
  media: (string | { state: string; ws: string })[];
  /** Assets the live `post_media` rows hold, which admission must ignore. */
  live?: string[];
  /** Seconds ago the target fell due: 30 is within the two-hour tolerance, 3 hours is late. */
  dueAgo?: number;
}
async function plantTarget(o: Target): Promise<{ variant: string; provider: string; media: string[] }> {
  const provider = `gating-${randomUUID().slice(0, 8)}`;
  const channel = (
    await rows(
      `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
       VALUES ($1, $2, 'profile', $2, $2, 'connected') RETURNING id`,
      [WA, provider],
    )
  )[0]?.id as string;
  const post = (
    await rows(
      "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
      [WA, U.editor],
    )
  )[0]?.id as string;
  const media: string[] = [];
  for (const item of o.media)
    media.push(typeof item === "string" ? item : await plantAsset(item.state, item.ws));
  const snapshot = {
    version: 1,
    draft: { variants: [] },
    resolved: {
      variants: [],
      media: Object.fromEntries(media.map((id) => [id, "ab".repeat(32)])),
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
  // The live rows are planted with the triggers off: the attach guard would refuse a medium that is not ready, and the row
  // is about a live row that names one.
  for (const [position, id] of (o.live ?? []).entries())
    await admin(async (client) => {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "INSERT INTO app.post_media (workspace_id, variant_id, position, media_id) VALUES ($1, $2, $3, $4)",
        [WA, variant, position, id],
      );
      await client.query("COMMIT");
    });
  return { variant, provider, media };
}

async function admit(provider: string): Promise<void> {
  const client = await openTx(db.pool("worker"), LEDGER);
  try {
    await client.query("SELECT * FROM app.admit_due_targets(100, $1::jsonb)", [
      JSON.stringify({ [provider]: LEASE }),
    ]);
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

describe("admission waits for the media of the frozen snapshot", () => {
  it.each(["uploaded", "processing", "rejected", "deleted"])(
    "a not-late target whose medium is %s stays scheduled, and is admitted once the medium is ready",
    async (state) => {
      const t = await plantTarget({
        media: [
          { state: "ready", ws: WA },
          { state, ws: WA },
        ],
      });
      await admit(t.provider);
      expect(await outcomeOf(t.variant)).toEqual({ schedule: "scheduled", operations: [] });
      if (state === "rejected" || state === "deleted") return;
      await rows("UPDATE app.media_assets SET state = 'ready' WHERE id = $1", [t.media[1]]);
      await admit(t.provider);
      expect(await outcomeOf(t.variant)).toEqual({ schedule: "in_progress", operations: ["pending"] });
    },
  );

  it("a late target is missed, not skipped, whatever its media", async () => {
    const t = await plantTarget({ media: [{ state: "processing", ws: WA }], dueAgo: 3 * 3600 });
    await admit(t.provider);
    expect((await outcomeOf(t.variant)).operations).toEqual(["missed"]);
  });

  it("a snapshot id that is ready only in another workspace, or is unknown, counts as not ready", async () => {
    const foreign = await plantTarget({ media: [{ state: "ready", ws: WB }] });
    const unknown = await plantTarget({ media: [randomUUID()] });
    for (const t of [foreign, unknown]) {
      await admit(t.provider);
      expect(await outcomeOf(t.variant)).toEqual({ schedule: "scheduled", operations: [] });
    }
  });

  it("the live post_media rows are ignored: only the frozen snapshot decides", async () => {
    const stillUploaded = await plantAsset("uploaded");
    const readyLive = await plantAsset("ready");
    const admitted = await plantTarget({ media: [{ state: "ready", ws: WA }], live: [stillUploaded] });
    const waiting = await plantTarget({ media: [{ state: "uploaded", ws: WA }], live: [readyLive] });
    await admit(admitted.provider);
    await admit(waiting.provider);
    expect([
      (await outcomeOf(admitted.variant)).operations,
      (await outcomeOf(waiting.variant)).operations,
    ]).toEqual([["pending"], []]);
  });
});
