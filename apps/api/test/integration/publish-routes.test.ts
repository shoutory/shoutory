import { randomUUID } from "node:crypto";
import { SealedSecret } from "@shoutory/core/crypto";
import { withSystem } from "@shoutory/db/context/system";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { fixtureOAuthManifest } from "@shoutory/testkit/fixture-oauth/manifest";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leaks } from "../support/canary.js";
import { probeWhileHeld, rowLock } from "../support/lock-probe.js";
import {
  addWorkspaceMember,
  seedChannel,
  seedOrganization,
  seedWorkspace,
  signedUser,
} from "../support/tenancy.js";
import { type Fixture, PEPPER, startFixture } from "./auth/harness.js";

// The publish, schedule, unschedule, cancel, edit and delete routes and the post detail reads: who may call each, what a
// foreign id does, the key check, one admission per click, the order of the locks and what a read may show.
type User = { id: string; cookie: string };
const manifest = manifestSchema.parse({
  ...fixtureOAuthManifest,
  providerDefault: { max_length: 280, sensitive: false, tag: "x" },
  actionWindows: { edit: 3600, delete: 3600 },
});
let fx: Fixture;
let ws: string;
let other: string;
let channel: string;
let otherChannel: string;
const users: Record<string, User> = {};
const user = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};
// The author is an Editor; the second Editor wrote nothing.
const SEATS: [string, string][] = [
  ["owner", "owner"],
  ["admin", "admin"],
  ["author", "editor"],
  ["editor", "editor"],
  ["approver", "approver"],
  ["viewer", "viewer"],
];

beforeAll(async () => {
  fx = await startFixture({
    channels: {
      providers: {
        fixture_oauth: {
          adapter: createFixtureAdapter({ baseUrl: "http://127.0.0.1:1", clientId: "c" }),
          manifest,
        },
      },
      fetch,
      pepper: new SealedSecret(PEPPER),
    },
  });
  const founder = await signedUser(fx, "pub-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const [name, role] of SEATS) {
    users[name] = await signedUser(fx, `pub-${name}`);
    await addWorkspaceMember(fx, ws, user(name).id, role);
  }
  users.foreign = await signedUser(fx, "pub-foreign");
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
  channel = await seedChannel(fx, ws, "connected", "pub-c1", "fixture_oauth");
  otherChannel = await seedChannel(fx, other, "connected", "pub-other", "fixture_oauth");
});
afterAll(() => fx.close());

const base = (workspace: string) => `/api/v1/workspaces/${workspace}/posts`;
const variantOf = (target: string, text = "hello") => ({
  channel_id: target,
  locale: null,
  post_type: "text",
  text,
  parts: [],
  settings: {},
  media: [],
});
let keyNo = 0;
const key = () => `pub-key-${++keyNo}`;
const send = (
  who: User,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  fx.request(path, {
    method,
    headers: { cookie: who.cookie, ...headers },
    ...(body === undefined ? {} : { body }),
  });
const errorOf = async (answer: Response) =>
  ((await answer.json()) as { error?: { code: string; details?: Record<string, unknown> } }).error;
const dataOf = async (answer: Response) => ((await answer.json()) as { data: Record<string, unknown> }).data;

type Stage = "draft" | "scheduled" | "published" | "in_flight";
interface Planted {
  post: string;
  version: string;
  variant: string;
  workspace: string;
  channel: string;
  op?: string;
}
type Admin = Parameters<Parameters<Fixture["admin"]>[0]>[0];

async function plantOperation(
  client: Admin,
  p: Planted,
  state: string,
  effect: string,
  kind = "publish",
  part = 0,
) {
  const frozen = (
    await client.query("SELECT frozen_version_id AS id FROM app.post_variants WHERE id = $1", [p.variant])
  ).rows[0].id as string;
  await client.query("BEGIN");
  await client.query("SET LOCAL session_replication_role = replica");
  const made = await client.query(
    `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect,
       last_actor, due_at, next_attempt_at, lateness_deadline, idempotency_marker, frozen_version_id,
       frozen_snapshot_hash, requested_by, lease_seconds, fencing_token, part_index)
     VALUES ($1, $2, $3, 'fixture_oauth', 'publish.fixture_oauth', $4, $5, $6, 'S', now() - interval '2 minutes',
       now() - interval '1 minute', now() + interval '2 hours', $7, $8, decode(repeat('ab', 32), 'hex'),
       (SELECT author_id FROM app.posts WHERE id = $9), 60, 1, $10)
     RETURNING id`,
    [p.workspace, p.variant, p.channel, kind, state, effect, `pub-${randomUUID()}`, frozen, p.post, part],
  );
  await client.query("COMMIT");
  return made.rows[0].id as string;
}

// The post is made through the route, so its draft is one the manifest accepts; the later stages are planted around it.
async function plant(
  stage: Stage,
  o: { workspace?: string; channel?: string; author?: User; ageSeconds?: number } = {},
) {
  const home = o.workspace ?? ws;
  const target = o.channel ?? channel;
  const who = o.author ?? (home === ws ? user("author") : user("foreign"));
  const made = await send(who, "POST", base(home), { draft: { variants: [variantOf(target)] } });
  const created = await dataOf(made);
  const p: Planted = {
    post: created.id as string,
    version: created.version_id as string,
    variant: "",
    workspace: home,
    channel: target,
  };
  await fx.admin(async (client) => {
    p.variant = (
      await client.query("SELECT id FROM app.post_variants WHERE post_id = $1", [p.post])
    ).rows[0].id;
    if (stage === "draft") return;
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const settled = stage === "published";
    await client.query(
      `UPDATE app.post_variants SET schedule_state = $2, frozen_version_id = $3,
         local_due = '2099-01-05 09:00', due_tz = 'UTC', due_at = $4::timestamptz,
         external_id = CASE WHEN $5 THEN 'remote-1' END, presence = 'present',
         published_at = CASE WHEN $5 THEN now() - make_interval(secs => $6::float8) END
       WHERE id = $1`,
      [
        p.variant,
        { scheduled: "scheduled", published: "settled", in_flight: "in_progress" }[stage],
        p.version,
        settled || stage === "in_flight" ? new Date(Date.now() - 600_000) : new Date("2099-01-05T09:00:00Z"),
        settled,
        o.ageSeconds ?? 300,
      ],
    );
    await client.query("UPDATE app.posts SET status = $2 WHERE id = $1", [
      p.post,
      settled ? "published" : "scheduled",
    ]);
    await client.query("COMMIT");
    if (stage === "published") await plantOperation(client, p, "published", "confirmed");
    if (stage === "in_flight") p.op = await plantOperation(client, p, "dispatching", "possible");
  });
  return p;
}

const stateOf = async (p: Planted) =>
  fx.admin(async (client) => {
    const rows = async (sql: string) => (await client.query(sql, [p.post])).rows;
    return {
      variants: await rows(
        "SELECT schedule_state, presence, due_at, frozen_version_id FROM app.post_variants WHERE post_id = $1 ORDER BY id",
      ),
      operations: await rows(
        `SELECT o.kind, o.state FROM app.operations o JOIN app.post_variants v ON v.id = o.variant_id
         WHERE v.post_id = $1 ORDER BY o.created_at, o.id`,
      ),
      versions: await rows(
        "SELECT version_no, kind FROM app.post_versions WHERE post_id = $1 ORDER BY version_no",
      ),
      post: await rows("SELECT status, deleted_at FROM app.posts WHERE id = $1"),
    };
  });
const publishNowOf = (p: Planted) =>
  fx.admin(
    async (client) =>
      (await client.query("SELECT publish_now FROM app.post_variants WHERE id = $1", [p.variant])).rows[0]
        .publish_now as boolean,
  );
// What the 30-second tick does: publish now only marks the target due, and admission makes its operation.
const admit = () =>
  withSystem(fx.db.pool("worker"), "ledger", (tx) =>
    tx.query("SELECT * FROM app.admit_due_targets(100, $1::jsonb)", [
      JSON.stringify({
        fixture_oauth: { margin_seconds: 300, lease_seconds: { publish: 60, delete: 60, edit: 60 } },
      }),
    ]),
  );
const operationsOf = async (p: Planted, kind: string) =>
  (await stateOf(p)).operations.filter((row) => row.kind === kind);

interface Route {
  name: string;
  method: string;
  stage: Stage;
  path: (p: Planted) => string;
  body?: (p: Planted) => unknown;
  headers?: (p: Planted) => Record<string, string>;
  /** True when the route's own effect is stored. */
  effect: (p: Planted) => Promise<boolean>;
}
const ifMatch = (p: Planted) => ({ "if-match": `"${p.version}"` });
const ROUTES: Route[] = [
  {
    name: "schedule",
    method: "POST",
    stage: "draft",
    path: (p) => `${base(p.workspace)}/${p.post}/schedule`,
    body: () => ({ local_due: "2099-01-05T09:00" }),
    effect: async (p) => (await stateOf(p)).variants[0]?.schedule_state === "scheduled",
  },
  {
    name: "unschedule",
    method: "POST",
    stage: "scheduled",
    path: (p) => `${base(p.workspace)}/${p.post}/unschedule`,
    body: () => ({}),
    effect: async (p) => (await stateOf(p)).variants[0]?.schedule_state === "draft",
  },
  {
    name: "publish now",
    method: "POST",
    stage: "draft",
    path: (p) => `${base(p.workspace)}/${p.post}/publish`,
    body: () => ({}),
    effect: async (p) => {
      const [row] = (await stateOf(p)).variants;
      return row?.schedule_state === "scheduled" && (await publishNowOf(p)) === true;
    },
  },
  {
    name: "edit",
    method: "POST",
    stage: "published",
    path: (p) => `${base(p.workspace)}/${p.post}/edit`,
    body: (p) => ({ draft: { variants: [variantOf(p.channel, "edited")] } }),
    headers: ifMatch,
    effect: async (p) => (await operationsOf(p, "edit")).length === 1,
  },
  {
    name: "delete",
    method: "DELETE",
    stage: "published",
    path: (p) => `${base(p.workspace)}/${p.post}`,
    headers: ifMatch,
    effect: async (p) => (await operationsOf(p, "delete")).length === 1,
  },
];
const routeNamed = (name: string): Route => {
  const found = ROUTES.find((route) => route.name === name);
  if (!found) throw new Error(`no route ${name}`);
  return found;
};
const call = (who: User, route: Route, p: Planted, headers: Record<string, string> = {}) =>
  send(who, route.method, route.path(p), route.body?.(p), {
    "idempotency-key": key(),
    ...route.headers?.(p),
    ...headers,
  });

// [seat, status]: the five routes take posts.edit, so an Editor who did not write the post may use them.
const EDIT_ROLES: [string, number][] = [
  ["viewer", 403],
  ["approver", 403],
  ["editor", 200],
  ["author", 200],
  ["admin", 200],
  ["owner", 200],
];
describe("who may call the write routes (posts.edit)", () => {
  it.each(ROUTES.flatMap((route) => EDIT_ROLES.map(([seat, status]) => [route.name, seat, status] as const)))(
    "%s: %s answers %i",
    async (name, seat, status) => {
      const route = routeNamed(name);
      const p = await plant(route.stage);
      const before = await stateOf(p);
      const answered = await call(user(seat), route, p);
      expect(answered.status).toBe(status);
      if (status === 200) {
        expect(await route.effect(p)).toBe(true);
        return;
      }
      expect((await errorOf(answered))?.code).toBe("forbidden");
      expect(await stateOf(p)).toEqual(before);
      // The route exists and the target was valid: the Owner uses it, so the refusal was the role's.
      expect((await call(user("owner"), route, p)).status).toBe(200);
    },
  );
});

describe("who may cancel an operation", () => {
  const CANCEL: [string, number][] = [
    ["viewer", 403],
    ["approver", 403],
    ["editor", 404],
    ["author", 200],
    ["admin", 200],
    ["owner", 200],
  ];
  it.each(CANCEL)("%s answers %i (Owner, Admin or the post author may)", async (seat, status) => {
    const p = await plant("scheduled");
    const op = await fx.admin((client) => plantOperation(client, p, "pending", "none"));
    const answered = await send(
      user(seat),
      "POST",
      `/api/v1/workspaces/${ws}/operations/${op}/cancel`,
      {},
      {
        "idempotency-key": key(),
      },
    );
    expect(answered.status).toBe(status);
    expect((await operationsOf(p, "publish"))[0]?.state).toBe(status === 200 ? "cancelled" : "pending");
    if (status !== 200) {
      // The route exists and the operation was valid: the Owner cancels the same one, so the refusal was the role's.
      const owner = await send(
        user("owner"),
        "POST",
        `/api/v1/workspaces/${ws}/operations/${op}/cancel`,
        {},
        {
          "idempotency-key": key(),
        },
      );
      expect(owner.status).toBe(200);
    }
  });
});

describe("the post detail shows evidence and attempts by role", () => {
  // [seat, evidence line (posts.edit), attempts line (publish.resolve: Owner and Admin)]
  const READS: [string, boolean, boolean][] = [
    ["viewer", false, false],
    ["approver", false, false],
    ["editor", true, false],
    ["author", true, false],
    ["admin", true, true],
    ["owner", true, true],
  ];
  it.each(READS)(
    "%s sees evidence: %s, attempts: %s, and every setting",
    async (seat, evidence, attempts) => {
      const p = await plant("in_flight");
      await fx.admin((client) =>
        client.query(
          `INSERT INTO app.operation_attempts (workspace_id, operation_id, attempt_no, step, fencing_token, effect, http_status,
           error_class) VALUES ($1, $2, 1, 'commit', 1, 'possible', 502, 'provider_error')`,
          [ws, p.op],
        ),
      );
      const answered = await send(user(seat), "GET", `${base(ws)}/${p.post}`);
      expect(answered.status).toBe(200);
      const targets = (await dataOf(answered)).targets as Record<string, unknown>[];
      expect(targets).toHaveLength(1);
      const [target] = targets;
      expect(target?.variant_id).toBe(p.variant);
      expect(target?.schedule_state).toBe("in_progress");
      expect(target?.settings).toEqual({});
      expect("evidence" in (target ?? {})).toBe(evidence);
      expect("attempts" in (target ?? {})).toBe(attempts);
    },
  );
});

describe("a foreign post, variant or operation id", () => {
  it.each(ROUTES)(
    "$name: answers 404 like a missing id, and nothing changes in either workspace",
    async (route) => {
      const foreign = await plant(route.stage, { workspace: other, channel: otherChannel });
      const mine = await plant(route.stage);
      const [foreignBefore, mineBefore] = [await stateOf(foreign), await stateOf(mine)];
      const missing = await call(user("admin"), route, { ...mine, post: randomUUID() });
      const through = await call(user("admin"), route, { ...foreign, workspace: ws });
      const reverse = await call(user("foreign"), route, { ...mine, workspace: other });
      const shape = async (answered: Response) => [answered.status, (await errorOf(answered))?.code];
      const gone = await shape(missing);
      expect([await shape(through), await shape(reverse)]).toEqual([gone, gone]);
      expect(gone[0]).toBe(404);
      expect(await stateOf(foreign)).toEqual(foreignBefore);
      expect(await stateOf(mine)).toEqual(mineBefore);
      // The route exists: the same call on a post of its own workspace is not a 404.
      expect((await call(user("admin"), route, mine)).status).toBe(200);
    },
  );
});

describe("a foreign variant or operation id", () => {
  it("a variant of another post named in variant_ids is refused and changes nothing", async () => {
    const [mine, theirs] = [await plant("draft"), await plant("draft")];
    const before = await stateOf(theirs);
    const answered = await send(
      user("admin"),
      "POST",
      `${base(ws)}/${mine.post}/schedule`,
      { local_due: "2099-01-05T09:00", variant_ids: [theirs.variant] },
      { "idempotency-key": key() },
    );
    expect(answered.status).toBe(404);
    expect(await stateOf(theirs)).toEqual(before);
    expect((await stateOf(mine)).variants[0]?.schedule_state).toBe("draft");
    const own = await send(
      user("admin"),
      "POST",
      `${base(ws)}/${mine.post}/schedule`,
      { local_due: "2099-01-05T09:00", variant_ids: [mine.variant] },
      { "idempotency-key": key() },
    );
    expect(own.status).toBe(200);
  });

  it("an operation of another workspace cannot be cancelled through this one", async () => {
    const foreign = await plant("scheduled", { workspace: other, channel: otherChannel });
    const op = await fx.admin((client) => plantOperation(client, foreign, "pending", "none"));
    const answered = await send(
      user("admin"),
      "POST",
      `/api/v1/workspaces/${ws}/operations/${op}/cancel`,
      {},
      {
        "idempotency-key": key(),
      },
    );
    expect(answered.status).toBe(404);
    expect((await operationsOf(foreign, "publish"))[0]?.state).toBe("pending");
    const home = await send(
      user("foreign"),
      "POST",
      `/api/v1/workspaces/${other}/operations/${op}/cancel`,
      {},
      {
        "idempotency-key": key(),
      },
    );
    expect(home.status).toBe(200);
  });
});

describe("the Idempotency-Key check", () => {
  const BAD_KEYS: [string, Record<string, string>][] = [
    ["a missing key", {}],
    ["an empty key", { "idempotency-key": "" }],
    ["a key of 256 characters", { "idempotency-key": "k".repeat(256) }],
    ["a key with a character beyond ASCII", { "idempotency-key": "café" }],
    ["a key with a control character", { "idempotency-key": "a\u007fb" }],
    ["a key of spaces only", { "idempotency-key": "   " }],
    ["a key with a space inside", { "idempotency-key": "two words" }],
  ];
  const withoutKey = (route: Route, p: Planted, headers: Record<string, string>) =>
    send(user("owner"), route.method, route.path(p), route.body?.(p), { ...route.headers?.(p), ...headers });

  it.each(ROUTES.flatMap((route) => BAD_KEYS.map(([name, headers]) => [route.name, name, headers] as const)))(
    "%s: %s is 400 validation_failed idempotency_key_required and changes nothing",
    async (routeName, _name, headers) => {
      const route = routeNamed(routeName);
      const p = await plant(route.stage);
      const before = await stateOf(p);
      const refused = await withoutKey(route, p, headers);
      const error = await errorOf(refused);
      expect([refused.status, error?.code, error?.details?.reason]).toEqual([
        400,
        "validation_failed",
        "idempotency_key_required",
      ]);
      expect(await stateOf(p)).toEqual(before);
    },
  );

  it("cancel refuses a missing key too", async () => {
    const p = await plant("scheduled");
    const op = await fx.admin((client) => plantOperation(client, p, "pending", "none"));
    const refused = await send(user("owner"), "POST", `/api/v1/workspaces/${ws}/operations/${op}/cancel`, {});
    expect([refused.status, (await errorOf(refused))?.details?.reason]).toEqual([
      400,
      "idempotency_key_required",
    ]);
  });

  it.each(ROUTES)("$name: a key of 255 printable characters is accepted", async (route) => {
    const p = await plant(route.stage);
    const answered = await call(user("owner"), route, p, { "idempotency-key": "k".repeat(255) });
    expect(answered.status).toBe(200);
  });

  it("delete also needs If-Match: a key without it is 428", async () => {
    const p = await plant("published");
    const refused = await send(user("owner"), "DELETE", `${base(ws)}/${p.post}`, undefined, {
      "idempotency-key": key(),
    });
    expect([refused.status, (await errorOf(refused))?.code]).toEqual([428, "precondition_required"]);
    expect((await operationsOf(p, "delete")).length).toBe(0);
  });
});

describe("one click admits one operation", () => {
  const twice = async (route: Route, p: Planted, who = user("owner")) =>
    Promise.all([call(who, route, p), call(who, route, p)]);

  it.each(ROUTES.filter((route) => ["publish now", "edit", "delete"].includes(route.name)))(
    "two $name clicks give one operation, and no answer is a server error",
    async (route) => {
      const p = await plant(route.stage);
      const answers = await twice(route, p);
      expect(answers.some((answered) => answered.status === 200)).toBe(true);
      expect(answers.every((answered) => answered.status < 500)).toBe(true);
      const kind = route.name === "publish now" ? "publish" : route.name;
      if (kind === "publish") {
        await admit();
        await admit();
      }
      expect((await operationsOf(p, kind)).length).toBe(1);
    },
  );
});

describe("two writers on one target", () => {
  it("two clicks with the same key give one operation too", async () => {
    const p = await plant("draft");
    const route = ROUTES.find((r) => r.name === "publish now") as Route;
    const same = { "idempotency-key": "pub-same-key" };
    const answers = await Promise.all([
      call(user("owner"), route, p, same),
      call(user("admin"), route, p, same),
    ]);
    expect(answers.every((answered) => answered.status < 500)).toBe(true);
    await admit();
    expect((await operationsOf(p, "publish")).length).toBe(1);
  });

  it("a schedule and a publish now racing for one target leave at most one operation in flight", async () => {
    const p = await plant("draft");
    const [schedule, publish] = ROUTES.filter((r) => ["schedule", "publish now"].includes(r.name)) as [
      Route,
      Route,
    ];
    const answers = await Promise.all([call(user("owner"), schedule, p), call(user("admin"), publish, p)]);
    expect(answers.every((answered) => answered.status < 500)).toBe(true);
    expect(answers.some((answered) => answered.status === 200)).toBe(true);
    const live = (await stateOf(p)).operations.filter((row) =>
      ["pending", "claimed", "dispatching"].includes(String(row.state)),
    );
    expect(live.length).toBeLessThanOrEqual(1);
  });

  it("publish now sets the claim priority of its operation and queues it on the provider's own queue", async () => {
    const p = await plant("draft");
    const route = ROUTES.find((r) => r.name === "publish now") as Route;
    expect((await call(user("owner"), route, p)).status).toBe(200);
    expect((await operationsOf(p, "publish")).length).toBe(0);
    await admit();
    const row = await fx.admin(
      async (client) =>
        (
          await client.query(
            "SELECT priority, queue FROM app.operations WHERE variant_id = $1 AND kind = 'publish'",
            [p.variant],
          )
        ).rows[0],
    );
    expect(row).toEqual({ priority: true, queue: "publish.fixture_oauth" });
  });
});

describe("Undo after publish now", () => {
  it("unschedule leaves no operation and clears publish_now", async () => {
    const p = await plant("draft");
    const publish = routeNamed("publish now");
    const undo = routeNamed("unschedule");
    expect((await call(user("owner"), publish, p)).status).toBe(200);
    const flagged = await fx.admin(
      async (client) =>
        (await client.query("SELECT publish_now FROM app.post_variants WHERE id = $1", [p.variant])).rows[0]
          .publish_now,
    );
    expect(flagged).toBe(true);
    expect((await call(user("owner"), undo, p)).status).toBe(200);
    const after = await stateOf(p);
    expect(after.operations).toEqual([]);
    expect(after.variants[0]?.schedule_state).toBe("draft");
    const cleared = await fx.admin(
      async (client) =>
        (await client.query("SELECT publish_now FROM app.post_variants WHERE id = $1", [p.variant])).rows[0]
          .publish_now,
    );
    expect(cleared).toBe(false);
  });
});

describe("lock order: the post is locked before the variant, the channel or the operation", () => {
  // The writer waits on a held post row; while it waits it holds no row of a later rank.
  it.each(ROUTES.filter((route) => ["schedule", "edit", "delete"].includes(route.name)))(
    "$name takes the post row first",
    async (route) => {
      const p = await plant(route.stage);
      const outcome = await probeWhileHeld(
        fx.admin,
        rowLock("posts", p.post),
        () => call(user("owner"), route, p),
        [rowLock("post_variants", p.variant), rowLock("channels", p.channel)],
      );
      expect(outcome.free).toEqual([true, true]);
      expect(outcome.response.status).toBe(200);
    },
  );
});

describe("the post detail never shows a provider's words or a token", () => {
  const CANARIES = ["canary-provider-body-1", "canary-access-token-1"];

  it("the five forms of the planted error body and token are absent from the detail, for every role", async () => {
    const p = await plant("in_flight");
    await fx.admin((client) =>
      client.query(
        `INSERT INTO app.operation_attempts (workspace_id, operation_id, attempt_no, step, fencing_token, effect,
           http_status, error_class, provider_code, response_excerpt)
         VALUES ($1, $2, 1, 'commit', 1, 'possible', 502, 'provider_error', $3, $4)`,
        [ws, p.op, CANARIES[1], `{"error":"${CANARIES[0]}"}`],
      ),
    );
    for (const [seat] of SEATS) {
      const answered = await send(user(seat), "GET", `${base(ws)}/${p.post}`);
      expect(answered.status).toBe(200);
      const text = await answered.text();
      expect(text).toContain(p.variant);
      expect(text).toContain("targets");
      expect(leaks(text, CANARIES)).toEqual([]);
    }
  });
});

const rowsOf = (sql: string, params: unknown[]) =>
  fx.admin(async (client) => (await client.query(sql, params)).rows);

describe("refusals of an edit and a delete", () => {
  it.each(["edit", "delete"])(
    "%s while an operation is in flight answers 409 post_in_flight",
    async (name) => {
      const route = routeNamed(name);
      const p = await plant("in_flight");
      const before = await stateOf(p);
      const answered = await call(user("owner"), route, p);
      const error = await errorOf(answered);
      expect([answered.status, error?.code, error?.details?.reason]).toEqual([
        409,
        "conflict",
        "post_in_flight",
      ]);
      expect(error?.details?.actions).toEqual(["duplicate"]);
      expect(await stateOf(p)).toEqual(before);
    },
  );

  it.each([
    ["edit", "edit_window_closed"],
    ["delete", "delete_window_closed"],
  ])(
    "%s after the provider's window answers 409 %s and changes nothing",
    async (name, reason) => {
      const p = await plant("published", { ageSeconds: 7200 });
      const before = await stateOf(p);
      const answered = await call(user("owner"), routeNamed(name), p);
      const error = await errorOf(answered);
      expect([answered.status, error?.code, error?.details?.reason]).toEqual([409, "conflict", reason]);
      expect(await stateOf(p)).toEqual(before);
    },
  );
});

describe("an edit of a published post", () => {
  it("an edit writes the new version, the new text and one edit operation of the requester", async () => {
    const p = await plant("published");
    const answered = await call(user("author"), routeNamed("edit"), p);
    expect(answered.status).toBe(200);
    const version = (await dataOf(answered)).version_id as string;
    expect(version).not.toBe(p.version);
    const [post] = await rowsOf("SELECT current_version_id FROM app.posts WHERE id = $1", [p.post]);
    expect(post.current_version_id).toBe(version);
    const [variant] = await rowsOf('SELECT "text" FROM app.post_variants WHERE id = $1', [p.variant]);
    expect(variant.text).toBe("edited");
    const ops = await rowsOf(
      `SELECT o.state, o.queue, o.lease_seconds, o.frozen_version_id, o.requested_by, o.priority
         FROM app.operations o WHERE o.variant_id = $1 AND o.kind = 'edit'`,
      [p.variant],
    );
    expect(ops).toEqual([
      {
        state: "pending",
        queue: "publish.fixture_oauth",
        lease_seconds: 120,
        frozen_version_id: version,
        requested_by: user("author").id,
        priority: false,
      },
    ]);
    const events = await rowsOf(
      `SELECT 1 FROM app.outbox WHERE workspace_id = $1 AND type = 'operation.admitted'
         AND payload ->> 'operation_id' IN (SELECT id::text FROM app.operations WHERE variant_id = $2 AND kind = 'edit')`,
      [ws, p.variant],
    );
    expect(events).toHaveLength(1);
  });

  it("an edit that changes nothing is refused and writes no version", async () => {
    const p = await plant("published");
    const answered = await send(
      user("owner"),
      "POST",
      routeNamed("edit").path(p),
      { draft: { variants: [variantOf(p.channel, "hello")] } },
      { "idempotency-key": key(), ...ifMatch(p) },
    );
    expect(answered.status).toBe(400);
    expect((await stateOf(p)).versions).toHaveLength(1);
  });

  it("an edit with a stale If-Match answers 412 and changes nothing", async () => {
    const p = await plant("published");
    expect((await call(user("owner"), routeNamed("edit"), p)).status).toBe(200);
    const stale = await call(user("owner"), routeNamed("edit"), p);
    expect(stale.status).toBe(412);
    expect((await operationsOf(p, "edit")).length).toBe(1);
  });
});

describe("a delete of a published post", () => {
  it("delete takes one operation per published target and marks the target as removal pending", async () => {
    const p = await plant("published");
    const answered = await call(user("owner"), routeNamed("delete"), p);
    expect(answered.status).toBe(200);
    const [row] = await rowsOf(
      `SELECT o.state, o.lease_seconds, o.part_index, o.priority, v.presence
         FROM app.operations o JOIN app.post_variants v ON v.id = o.variant_id
        WHERE o.variant_id = $1 AND o.kind = 'delete'`,
      [p.variant],
    );
    expect(row).toEqual({
      state: "pending",
      lease_seconds: 60,
      part_index: 0,
      priority: false,
      presence: "removal_pending",
    });
  });

  it("delete names its targets: a listed target is deleted and a foreign one is a 404", async () => {
    const [mine, theirs] = [await plant("published"), await plant("published")];
    const route = routeNamed("delete");
    const withBody = (target: Planted): [unknown, Record<string, string>] => {
      const body = { variant_ids: [target.variant] };
      return [
        body,
        { "idempotency-key": key(), "content-length": String(JSON.stringify(body).length), ...ifMatch(mine) },
      ];
    };
    const foreign = await send(user("owner"), "DELETE", route.path(mine), ...withBody(theirs));
    expect(foreign.status).toBe(404);
    expect((await operationsOf(theirs, "delete")).length).toBe(0);
    const own = await send(user("owner"), "DELETE", route.path(mine), ...withBody(mine));
    expect(own.status).toBe(200);
    expect((await operationsOf(mine, "delete")).length).toBe(1);
  });

  it("a thread delete starts with the highest published part", async () => {
    const p = await plant("published");
    await fx.admin((client) => plantOperation(client, p, "published", "confirmed", "publish", 1));
    await fx.admin((client) => plantOperation(client, p, "published", "confirmed", "publish", 2));
    expect((await call(user("owner"), routeNamed("delete"), p)).status).toBe(200);
    const parts = await rowsOf(
      "SELECT part_index FROM app.operations WHERE variant_id = $1 AND kind = 'delete'",
      [p.variant],
    );
    expect(parts).toEqual([{ part_index: 2 }]);
  });
});

describe("the one held-media predicate", () => {
  // [state of the medium, whether the target waits for it]
  const MEDIA: [string, boolean][] = [
    ["ready", false],
    ["processing", true],
    ["rejected", true],
    ["missing", true],
  ];
  it.each(MEDIA)(
    "a %s medium: admission, the detail reason and the predicate agree (held: %s)",
    async (state, held) => {
      const p = await plant("scheduled");
      const asset = randomUUID();
      await fx.admin(async (client) => {
        if (state !== "missing") {
          await client.query(
            `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, created_by, state, sha256)
             VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'held.mp4', 'video/mp4',
               'upload', $3::uuid, $4, decode(md5($1::text) || md5($2::text), 'hex'))`,
            [asset, ws, randomUUID(), state],
          );
        }
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `UPDATE app.post_versions SET snapshot = jsonb_set(snapshot, '{resolved,media}', jsonb_build_object($2::text, 'ab'))
            WHERE id = $1`,
          [p.version, asset],
        );
        await client.query(
          "UPDATE app.post_variants SET due_at = now() - interval '1 minute' WHERE id = $1",
          [p.variant],
        );
        await client.query("COMMIT");
      });
      const detail = (await dataOf(await send(user("owner"), "GET", `${base(ws)}/${p.post}`)))
        .targets as Record<string, unknown>[];
      const [predicate] = await fx.admin(
        async (client) =>
          (await client.query("SELECT app.media_held($1, $2) AS held", [ws, p.version])).rows as {
            held: boolean;
          }[],
      );
      await admit();
      expect([detail[0]?.hold_reason, predicate?.held, (await operationsOf(p, "publish")).length]).toEqual([
        held ? "held_media" : null,
        held,
        held ? 0 : 1,
      ]);
    },
  );
});

// A draft the route took (a draft may hold what a provider refuses), then changed in place as a stored fact.
async function planted(text: string, target = channel): Promise<Planted> {
  const made = await send(user("author"), "POST", base(ws), {
    draft: { variants: [variantOf(target, text)] },
  });
  const created = await dataOf(made);
  const p: Planted = {
    post: created.id as string,
    version: created.version_id as string,
    variant: "",
    workspace: ws,
    channel: target,
  };
  p.variant = (await rowsOf("SELECT id FROM app.post_variants WHERE post_id = $1", [p.post]))[0]?.id;
  return p;
}
const scheduleVia = (route: string, p: Planted) =>
  send(
    user("owner"),
    "POST",
    `${base(ws)}/${p.post}/${route}`,
    route === "schedule" ? { local_due: "2099-01-05T09:00" } : {},
    { "idempotency-key": key() },
  );

describe("the strict check at schedule and publish now", () => {
  // [case, the text, the issue the answer lists]
  const CASES: [string, string, { variant: number; key: string; reason: string }][] = [
    ["a text over the provider's limit", "x".repeat(501), { variant: 0, key: "text", reason: "too_long" }],
    ["nothing to send", "", { variant: 0, key: "text", reason: "empty" }],
  ];
  it.each(CASES.flatMap((row) => ["schedule", "publish"].map((route) => [route, ...row] as const)))(
    "%s: %s answers 422 variant_invalid with the issue and changes nothing",
    async (route, _name, text, issue) => {
      const p = await planted(text);
      const before = await stateOf(p);
      const answered = await scheduleVia(route, p);
      const error = await errorOf(answered);
      expect([answered.status, error?.code, error?.details?.reason, error?.details?.issues]).toEqual([
        422,
        "unprocessable_content",
        "variant_invalid",
        [issue],
      ]);
      expect(await stateOf(p)).toEqual(before);
    },
  );
});

describe("the media of a scheduled post", () => {
  const withMedium = async (state: string | null) => {
    const p = await planted("with a medium");
    const asset = randomUUID();
    await fx.admin(async (client) => {
      if (state !== null) {
        await client.query(
          `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, created_by, state, sha256)
           VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'm.mp4', 'video/mp4',
             'upload', $3::uuid, $4, decode(md5($1::text) || md5($2::text), 'hex'))`,
          [asset, ws, randomUUID(), state],
        );
      }
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE app.post_versions SET snapshot = jsonb_set(snapshot, '{draft,variants,0,media}',
           jsonb_build_array(jsonb_build_object('media_id', $2::text, 'alt_text', null, 'crop', null))) WHERE id = $1`,
        [p.version, asset],
      );
      await client.query("COMMIT");
    });
    return p;
  };
  // [the medium, the status]
  const MEDIA: [string | null, number][] = [
    ["rejected", 422],
    [null, 422],
    ["processing", 200],
  ];
  it.each(MEDIA)("a %s medium answers %i", async (state, status) => {
    const p = await withMedium(state);
    const answered = await scheduleVia("schedule", p);
    expect(answered.status).toBe(status);
    if (status === 422) expect((await errorOf(answered))?.details?.reason).toBe("media_unavailable");
    expect((await stateOf(p)).variants[0]?.schedule_state).toBe(status === 200 ? "scheduled" : "draft");
  });
});

describe("what a schedule does to the post", () => {
  it("freezes the current version by relabelling it, without a copy", async () => {
    const p = await planted("freeze me");
    expect((await scheduleVia("schedule", p)).status).toBe(200);
    const after = await stateOf(p);
    expect(after.versions).toEqual([{ version_no: 1, kind: "scheduled" }]);
    expect(after.variants[0]?.frozen_version_id).toBe(p.version);
  });

  it.each(["needs_reconnect", "disconnected", "revoked_by_provider"])(
    "a %s channel answers 409 channel_not_connected",
    async (connection) => {
      const own = await seedChannel(fx, ws, connection, `pub-${randomUUID()}`, "fixture_oauth");
      const p = await planted("no channel", own);
      const answered = await scheduleVia("schedule", p);
      const error = await errorOf(answered);
      expect([answered.status, error?.code, error?.details?.reason]).toEqual([
        409,
        "conflict",
        "channel_not_connected",
      ]);
      expect((await stateOf(p)).variants[0]?.schedule_state).toBe("draft");
    },
  );

  it("a disabled channel is accepted: its operation waits paused", async () => {
    const own = await seedChannel(fx, ws, "disabled", `pub-${randomUUID()}`, "fixture_oauth");
    const p = await planted("disabled", own);
    expect((await scheduleVia("schedule", p)).status).toBe(200);
  });
});

describe("the time of a schedule in the workspace zone", () => {
  // [local time, the choice, the status, the reason or the instant]
  const TIMES: [string, string | undefined, number, string][] = [
    ["2027-03-14T02:30", undefined, 422, "local_time_nonexistent"],
    ["2027-11-07T01:30", undefined, 422, "local_time_ambiguous"],
    ["2027-11-07T01:30", "earlier", 200, "2027-11-07T05:30:00.000Z"],
    ["2027-11-07T01:30", "later", 200, "2027-11-07T06:30:00.000Z"],
    ["2027-06-01T09:00", undefined, 200, "2027-06-01T13:00:00.000Z"],
  ];
  it.each(TIMES)("%s with %s answers %i (%s)", async (localDue, fold, status, expected) => {
    const zoned = await seedWorkspace(fx, await seedOrganization(fx, user("owner").id));
    await addWorkspaceMember(fx, zoned, user("owner").id, "owner");
    await fx.admin((client) =>
      client.query("UPDATE app.workspaces SET default_tz = 'America/New_York' WHERE id = $1", [zoned]),
    );
    const zonedChannel = await seedChannel(fx, zoned, "connected", `pub-${randomUUID()}`, "fixture_oauth");
    const made = await dataOf(
      await send(user("owner"), "POST", base(zoned), { draft: { variants: [variantOf(zonedChannel)] } }),
    );
    const answered = await send(
      user("owner"),
      "POST",
      `${base(zoned)}/${made.id}/schedule`,
      { local_due: localDue, ...(fold === undefined ? {} : { fold }) },
      { "idempotency-key": key() },
    );
    expect(answered.status).toBe(status);
    if (status === 422) expect((await errorOf(answered))?.details?.reason).toBe(expected);
    else expect(new Date(String((await dataOf(answered)).due_at)).toISOString()).toBe(expected);
  });
});

describe("the actions of the post detail come from the server", () => {
  // [stage, seat, the actions the server lists]
  const ACTIONS: [Stage, string, string[]][] = [
    ["draft", "viewer", []],
    ["draft", "editor", ["schedule", "publish_now", "duplicate"]],
    ["scheduled", "editor", ["schedule", "publish_now", "unschedule", "duplicate"]],
    ["published", "editor", ["edit", "delete", "duplicate"]],
    ["in_flight", "approver", []],
  ];
  it.each(ACTIONS)("a %s target shows the %s %j", async (stage, seat, expected) => {
    const p = await plant(stage);
    const targets = (await dataOf(await send(user(seat), "GET", `${base(ws)}/${p.post}`))).targets as {
      actions: string[];
    }[];
    expect(targets[0]?.actions).toEqual(expected);
  });
});
