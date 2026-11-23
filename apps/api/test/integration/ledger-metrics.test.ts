import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedFrozenVersion } from "../support/ledger-seed.js";
import { seedChannel, seedOrganization, seedWorkspace, signedUser, unique } from "../support/tenancy.js";
import { cookieOf, type Fixture, PASSWORD, startFixture } from "./auth/harness.js";

// Security floor of the ledger counts on the admin queue route (NFR-OBS-03, OPS-004): one value per state and
// nothing of any workspace. The instance admin is the first user to sign up; who else may reach the route is the table
// of `admin-ops-routes.test.ts`.
const QUEUE = "/api/v1/admin/queue";
const STATES = [
  "blocked_reconnect",
  "cancelled",
  "claimed",
  "dispatching",
  "failed",
  "missed",
  "needs_human",
  "paused",
  "pending",
  "processing",
  "provider_accepted",
  "published",
  "reconciling",
  "retry_wait",
  "superseded_after_unknown_outcome",
  "unknown_external_state",
  "unverified",
];

let fx: Fixture;
let adminEmail: string;
type Seat = { id: string; channel: string; channelId: string };
const workspaces: Seat[] = [];
// Planted as the definer would leave them; the text of the frozen version is "hello dispatch".
async function plantIn(workspace: Seat, state: string): Promise<void> {
  const channel = workspace.channelId;
  await fx.admin(async (client) => {
    const post = await client.query(
      "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', gen_random_uuid(), 'scheduled') RETURNING id",
      [workspace.id],
    );
    const variant = await client.query(
      "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, 'in_progress') RETURNING id",
      [workspace.id, post.rows[0].id, channel],
    );
    const frozen = await seedFrozenVersion(client, workspace.id, post.rows[0].id, channel);
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect,
         last_actor, due_at, next_attempt_at, lateness_deadline, idempotency_marker, frozen_version_id,
         frozen_snapshot_hash, requested_by, lease_seconds, fencing_token)
       VALUES ($1, $2, $3, 'fixture', 'publish.fixture', 'publish', $4, 'none', 'S', now(), now(),
         now() + interval '2 hours', gen_random_uuid()::text, $5, decode(repeat('ab', 32), 'hex'), gen_random_uuid(), 60, 1)`,
      [workspace.id, variant.rows[0].id, channel, state, frozen],
    );
    await client.query("COMMIT");
  });
}

beforeAll(async () => {
  fx = await startFixture();
  const first = await signedUser(fx, "ledger-admin");
  adminEmail = (
    await fx.admin((client) => client.query('SELECT email FROM auth."user" WHERE id = $1', [first.id]))
  ).rows[0].email;
  for (const label of ["alpha", "beta"]) {
    const owner = await signedUser(fx, `ledger-${label}`);
    const id = await seedWorkspace(fx, await seedOrganization(fx, owner.id));
    const channel = `canary-channel-${unique(label)}`;
    workspaces.push({ id, channel, channelId: await seedChannel(fx, id, "connected", channel, "fixture") });
  }
  const [alpha, beta] = workspaces as [Seat, Seat];
  for (const [workspace, state] of [
    [alpha, "pending"],
    [alpha, "pending"],
    [alpha, "paused"],
    [beta, "pending"],
    [beta, "needs_human"],
  ] as const)
    await plantIn(workspace, state);
});
afterAll(() => fx.close());

const queue = async () => {
  const cookie = cookieOf(
    await fx.request("/api/auth/sign-in/email", { body: { email: adminEmail, password: PASSWORD } }),
  );
  const answer = await fx.request(QUEUE, { headers: { cookie } });
  return { status: answer.status, text: await answer.text() };
};

describe("the ledger counts of the admin queue route", () => {
  it("are exactly the 17 {state, total} pairs and hold no workspace id, post text or channel name", async () => {
    // fails first because: the route has no `ledger` field, or a per-workspace breakdown leaks what the counts must not
    const { status, text } = await queue();
    expect(status).toBe(200);
    const { ledger } = (JSON.parse(text) as { data: { ledger?: Record<string, unknown>[] } }).data;
    expect(ledger?.map((row) => Object.keys(row).sort())).toEqual(Array(17).fill(["state", "total"]));
    expect(ledger?.map((row) => row.state).sort()).toEqual([...STATES].sort());
    expect(Object.fromEntries((ledger ?? []).map((row) => [row.state, row.total]))).toMatchObject({
      pending: 3,
      paused: 1,
      needs_human: 1,
      published: 0,
    });
    const answer = JSON.stringify(ledger);
    for (const secret of [...workspaces.flatMap((w) => [w.id, w.channel]), "hello dispatch", "fixture"])
      expect(answer, secret).not.toContain(secret);
  });
});
