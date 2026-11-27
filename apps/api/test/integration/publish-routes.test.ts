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

async function plantOperation(client: Admin, p: Planted, state: string, effect: string, kind = "publish") {
  const frozen = (
    await client.query("SELECT frozen_version_id AS id FROM app.post_variants WHERE id = $1", [p.variant])
  ).rows[0].id as string;
  await client.query("BEGIN");
  await client.query("SET LOCAL session_replication_role = replica");
  const made = await client.query(
    `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect,
       last_actor, due_at, next_attempt_at, lateness_deadline, idempotency_marker, frozen_version_id,
       frozen_snapshot_hash, requested_by, lease_seconds, fencing_token)
     VALUES ($1, $2, $3, 'fixture_oauth', 'publish.fixture_oauth', $4, $5, $6, 'S', now() - interval '2 minutes',
       now() - interval '1 minute', now() + interval '2 hours', $7, $8, decode(repeat('ab', 32), 'hex'),
       (SELECT author_id FROM app.posts WHERE id = $9), 60, 1)
     RETURNING id`,
    [p.workspace, p.variant, p.channel, kind, state, effect, `pub-${randomUUID()}`, frozen, p.post],
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
