import { randomUUID } from "node:crypto";
import type { AppPool } from "@shoutory/db/pool";
import type { withAdminClient } from "@shoutory/db/testing";
import { connectChannel } from "./ledger-credentials.js";

// The admin client of the db package's test helper (this package does not depend on the driver itself).
type Client = Parameters<Parameters<typeof withAdminClient>[2]>[0];

// A workspace with its owner for the ledger tests, and a target the admission can take, written through the admin client
// the runtime roles cannot use.
export async function seedWorkspace(admin: Client): Promise<string> {
  const [user, org, workspace] = [randomUUID(), randomUUID(), randomUUID()];
  await admin.query("BEGIN");
  await admin.query('INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)', [
    user,
    "ledger-seed",
    `${user}@example.test`,
  ]);
  await admin.query("INSERT INTO app.organizations (id, name, slug, type) VALUES ($1, 'ls', $2, 'team')", [
    org,
    `ls-${org}`,
  ]);
  await admin.query(
    "INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES ($1, $2, 'owner')",
    [org, user],
  );
  await admin.query(
    "INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, 'ls', $3)",
    [workspace, org, `ls-${workspace}`],
  );
  await admin.query(
    `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
     VALUES ($1, $2, (SELECT r.id FROM app.roles r WHERE r.workspace_id IS NULL AND r.key = 'owner'))`,
    [workspace, user],
  );
  await admin.query("COMMIT");
  return workspace;
}

/** The frozen version of a post with the text of one channel's variant, as scheduling leaves it; answers its id. */
export async function seedFrozenVersion(
  admin: Client,
  workspace: string,
  post: string,
  channel: string,
): Promise<string> {
  const snapshot = {
    version: 1,
    draft: {
      variants: [
        {
          channel_id: channel,
          locale: null,
          post_type: "text",
          text: "hello dispatch",
          parts: [],
          settings: {},
          media: [],
        },
      ],
    },
    resolved: {
      variants: [{ channel_id: channel, locale: null, settings: {} }],
      media: {},
      manifestDigest: {},
    },
  };
  const made = await admin.query(
    `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
     VALUES ($1, $2, 1, 'scheduled', $3::jsonb, decode(repeat('ab', 32), 'hex'), $4) RETURNING id`,
    [workspace, post, JSON.stringify(snapshot), randomUUID()],
  );
  return made.rows[0].id as string;
}

// The pool the channels of `seedDueTarget` are connected through (the credential service and its definers), set once by a
// test file that seeds targets; one that forgot fails here instead of planting a channel with no credential.
let credentialPool: AppPool | undefined;
export function connectThrough(pool: AppPool): void {
  credentialPool = pool;
}

/** A channel of the `fixture` provider and a scheduled variant on it that was due `dueSecondsAgo` seconds ago. */
export async function seedDueTarget(
  admin: Client,
  workspace: string,
  dueSecondsAgo = 30,
  provider = "fixture",
): Promise<string> {
  const account = `ls-${randomUUID().slice(0, 8)}`;
  if (credentialPool === undefined) throw new Error("call connectThrough(pool) before seeding a target");
  const channel = await connectChannel(credentialPool, { workspace, provider, account });
  const post = (
    await admin.query(
      "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
      [workspace, randomUUID()],
    )
  ).rows[0].id;
  const frozen = await seedFrozenVersion(admin, workspace, post, channel);
  const variant = await admin.query(
    `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, due_at, frozen_version_id)
     VALUES ($1, $2, $3, 'scheduled', now() - make_interval(secs => $4::float8), $5) RETURNING id`,
    [workspace, post, channel, dueSecondsAgo, frozen],
  );
  return variant.rows[0].id as string;
}
