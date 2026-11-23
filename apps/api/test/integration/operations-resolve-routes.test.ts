import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedFrozenVersion } from "../support/ledger-seed.js";
import {
  addWorkspaceMember,
  seedChannel,
  seedOrganization,
  seedWorkspace,
  signedUser,
  unique,
} from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// Security floor of the resolve routes (R607 (15), R614, R616): who may settle a stuck operation, the step-up, the refusals
// a definer makes, and the one audit row a resolution writes. Route A (`.../resolutions/confirmed`) has the step-up policy
// and the kinds attest_published, attest_not_executed, supersede and confirm_removed; route B (`.../resolutions`) has the
// session policy and publish_late, reschedule, drop and dismiss.
type User = { id: string; cookie: string };
let fx: Fixture;
let ws: string;
let other: string;
const users: Record<string, User> = {};
const user = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};
const SEATS: [string, string][] = [
  ["owner", "owner"],
  ["admin", "admin"],
  ["author", "editor"],
  ["writer", "editor"],
  ["editor", "editor"],
  ["approver", "approver"],
  ["viewer", "viewer"],
];

beforeAll(async () => {
  fx = await startFixture();
  const founder = await signedUser(fx, "res-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const [name, role] of SEATS) {
    users[name] = await signedUser(fx, `res-${name}`);
    await addWorkspaceMember(fx, ws, user(name).id, role);
  }
  users.foreign = await signedUser(fx, "res-foreign");
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(() => fx.close());

const routeA = (workspace: string, op: string) =>
  `/api/v1/workspaces/${workspace}/operations/${op}/resolutions/confirmed`;
const routeB = (workspace: string, op: string) =>
  `/api/v1/workspaces/${workspace}/operations/${op}/resolutions`;
const post = (who: User, path: string, body: Record<string, unknown>) =>
  fx.request(path, { method: "POST", headers: { cookie: who.cookie }, body });
const answer = async (response: Response) => {
  const found = (await response.json()) as {
    data?: Record<string, unknown>;
    error?: { code: string; details?: { reason?: string } };
  };
  return { status: response.status, ...found };
};

interface Plant {
  author: string;
  workspace?: string;
  state?: string;
  effect?: string;
  kind?: string;
  channel?: string;
}
// A post written by `author`, its target and one operation in a given state, planted as the definer would leave them.
async function plantOp(o: Plant): Promise<string> {
  const home = o.workspace ?? ws;
  const channel = await seedChannel(fx, home, o.channel ?? "connected", unique("res-channel"), "fixture");
  return fx.admin(async (client) => {
    const made = await client.query(
      "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
      [home, o.author],
    );
    const variant = await client.query(
      "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, 'in_progress') RETURNING id",
      [home, made.rows[0].id, channel],
    );
    const frozen = await seedFrozenVersion(client, home, made.rows[0].id, channel);
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const op = await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect,
         last_actor, due_at, next_attempt_at, lateness_deadline, idempotency_marker, frozen_version_id,
         frozen_snapshot_hash, requested_by, lease_seconds, fencing_token)
       VALUES ($1, $2, $3, 'fixture', 'publish.fixture', $4, $5, $6, 'S', now() - interval '2 minutes',
         now() - interval '1 minute', now() + interval '2 hours', $7, $8, decode(repeat('ab', 32), 'hex'), $9, 60, 1)
       RETURNING id`,
      [
        home,
        variant.rows[0].id,
        channel,
        o.kind ?? "publish",
        o.state ?? "needs_human",
        o.effect ?? "possible",
        `res-${randomUUID()}`,
        frozen,
        o.author,
      ],
    );
    await client.query("COMMIT");
    return op.rows[0].id as string;
  });
}
const count = async (sql: string, op: string): Promise<number> =>
  (await fx.admin((client) => client.query(sql, [op]))).rows[0].n;
const resolutions = (op: string) =>
  count("SELECT count(*)::int AS n FROM app.operation_resolutions WHERE operation_id = $1", op);
const audits = (op: string) =>
  count(
    "SELECT count(*)::int AS n FROM app.audit_logs WHERE action = 'operation.resolved' AND resource_id = $1",
    op,
  );
const stateOf = async (op: string): Promise<string> =>
  (await fx.admin((client) => client.query("SELECT state FROM app.operations WHERE id = $1", [op]))).rows[0]
    .state;
const untouched = async (op: string, state = "needs_human") => {
  expect([await stateOf(op), await resolutions(op), await audits(op)]).toEqual([state, 0, 0]);
};

// [role, route, kind, status, state after a 200]
const WHO: [string, "A" | "B", string, number, string][] = ["A", "B"].flatMap((route) =>
  (
    [
      ["owner", 200],
      ["admin", 200],
      ["author", 200],
      ["editor", 404],
      ["approver", 403],
      ["viewer", 403],
    ] as const
  ).map(
    ([role, status]) =>
      [
        role,
        route,
        route === "A" ? "attest_published" : "dismiss",
        status,
        route === "A" ? "published" : "unverified",
      ] as [string, "A" | "B", string, number, string],
  ),
);
describe("who may resolve an operation", () => {
  it.each(WHO)("%s on route %s with %s answers %i", async (role, route, kind, status, after) => {
    // fails first because: the routes do not exist, so every row answers 404
    const op = await plantOp({ author: role === "author" ? user("author").id : user("writer").id });
    const path = (route === "A" ? routeA : routeB)(ws, op);
    const answered = await answer(await post(user(role), path, { kind }));
    expect(answered.status).toBe(status);
    if (status !== 200) {
      await untouched(op);
      // The route exists and the operation was valid: the Owner settles the same one, so the refusal was the role's.
      expect((await post(user("owner"), path, { kind })).status).toBe(200);
      return;
    }
    expect(answered.data).toEqual({ operation_id: op, kind, new_operation_id: null });
    expect([await stateOf(op), await resolutions(op), await audits(op)]).toEqual([after, 1, 1]);
  });
});

describe("another workspace's operation", () => {
  it("answers 404 like a missing one, and nothing changes in either workspace", async () => {
    // fails first because: the routes do not exist, or the foreign id is read through this workspace's path
    const foreignOp = await plantOp({ author: user("foreign").id, workspace: other });
    const mine = await plantOp({ author: user("writer").id });
    const missing = await answer(await post(user("admin"), routeB(ws, randomUUID()), { kind: "dismiss" }));
    const through = await answer(await post(user("admin"), routeB(ws, foreignOp), { kind: "dismiss" }));
    const reverse = await answer(await post(user("foreign"), routeB(other, mine), { kind: "dismiss" }));
    // The request id differs per request; everything else of the answer is the same.
    const shape = (found: typeof missing) => [found.status, found.error?.code, found.error?.details];
    expect([shape(through), shape(reverse)]).toEqual([shape(missing), shape(missing)]);
    expect(shape(missing)[0]).toBe(404);
    await untouched(foreignOp);
    await untouched(mine);
  });
});

// [kind, the plant, the body]
const STEPPED: [string, Partial<Plant>, Record<string, unknown>][] = [
  ["attest_published", {}, {}],
  ["attest_not_executed", {}, { ack_text: "I checked the network" }],
  ["supersede", {}, { ack_text: "send it again" }],
  ["confirm_removed", { kind: "delete" }, {}],
];
const FREE: [string, Partial<Plant>, Record<string, unknown>][] = [
  ["publish_late", { effect: "none" }, {}],
  ["reschedule", { effect: "none" }, {}],
  ["drop", { effect: "none" }, {}],
  ["dismiss", {}, {}],
];
const stale = async (interval: string | null): Promise<User> => {
  const who = await signedUser(fx, "res-stale");
  await addWorkspaceMember(fx, ws, who.id, "admin");
  await fx.admin((client) =>
    interval === null
      ? client.query("DELETE FROM app.session_step_ups WHERE user_id = $1", [who.id])
      : client.query(
          "UPDATE app.session_step_ups SET at = clock_timestamp() - $2::interval WHERE user_id = $1",
          [who.id, interval],
        ),
  );
  return who;
};
describe("step-up on the resolve routes", () => {
  it.each(
    STEPPED.flatMap(
      (row) =>
        [
          ["11 minutes", ...row],
          [null, ...row],
        ] as const,
    ),
  )(
    "a stale step-up (%s) refuses %s with 403 step_up_required and writes nothing",
    async (interval, kind, planted, body) => {
      // fails first because: the routes do not exist, or the step-up is checked after the definer has acted
      const [who, op] = [await stale(interval), await plantOp({ author: user("writer").id, ...planted })];
      const refused = await answer(await post(who, routeA(ws, op), { kind, ...body }));
      expect([refused.status, refused.error?.code]).toEqual([403, "step_up_required"]);
      await untouched(op);
    },
  );

  it.each(FREE)("%s needs no step-up", async (kind, planted, body) => {
    // fails first because: the routes do not exist, or the session route asks for a step-up
    const [who, op] = [await stale("11 minutes"), await plantOp({ author: user("writer").id, ...planted })];
    expect((await post(who, routeB(ws, op), { kind, ...body })).status).toBe(200);
  });
});

describe("the body of a resolution", () => {
  // [what is posted, to which route, the plant]
  const BAD: [string, "A" | "B", Record<string, unknown>][] = [
    ["a step-up kind on the session route", "B", { kind: "attest_published" }],
    ["a session kind on the step-up route", "A", { kind: "dismiss" }],
    ["attest_not_executed with no ack_text", "A", { kind: "attest_not_executed" }],
    ["supersede with no ack_text", "A", { kind: "supersede" }],
    ["an absence_evidence_id that is not a uuid", "B", { kind: "drop", absence_evidence_id: "not-a-uuid" }],
    ["an unknown absence_evidence_id on a drop", "B", { kind: "drop", absence_evidence_id: randomUUID() }],
    ["a permalink that cannot be parsed", "A", { kind: "attest_published", permalink: "https://[bad" }],
    ["a NUL in the note", "B", { kind: "dismiss", note: "a\u0000b" }],
    ["a NUL in the permalink", "A", { kind: "attest_published", permalink: "https://example.test/a\u0000b" }],
    ["a lone surrogate in the ack_text", "A", { kind: "supersede", ack_text: "ab\ud800" }],
    ["a key the route does not know", "B", { kind: "dismiss", token: "x" }],
    ["a permalink that is not a URL", "A", { kind: "attest_published", permalink: "javascript:alert(1)" }],
  ];
  it.each(BAD)("%s is a 400 and writes nothing", async (_name, route, body) => {
    // fails first because: the routes do not exist, or a bad uuid reaches the definer as a 500
    const op = await plantOp({ author: user("writer").id, effect: "none" });
    const refused = await answer(await post(user("admin"), (route === "A" ? routeA : routeB)(ws, op), body));
    expect([refused.status, refused.error?.code]).toEqual([400, "validation_failed"]);
    await untouched(op);
  });
});

describe("a resolution the state or the channel refuses", () => {
  // [route, kind, body]: every kind that would send needs a connected channel
  const SENDS: ["A" | "B", string, Record<string, unknown>][] = [
    ["A", "attest_not_executed", { ack_text: "not sent" }],
    ["A", "supersede", { ack_text: "again" }],
    ["B", "publish_late", {}],
  ];
  it.each(SENDS)(
    "%s %s on a channel that is not connected is a 409 channel_not_connected",
    async (route, kind, body) => {
      // fails first because: the routes do not exist, or the refusal is a 500 or carries no reason
      const op = await plantOp({ author: user("writer").id, effect: "none", channel: "needs_reconnect" });
      const refused = await answer(
        await post(user("admin"), (route === "A" ? routeA : routeB)(ws, op), { kind, ...body }),
      );
      expect([refused.status, refused.error?.code, refused.error?.details?.reason]).toEqual([
        409,
        "conflict",
        "channel_not_connected",
      ]);
      await untouched(op);
    },
  );

  it("a second call of the same kind is a 409, leaves one resolution row and writes no second audit row", async () => {
    // fails first because: the routes do not exist, or the repeat is applied twice
    const op = await plantOp({ author: user("writer").id });
    const first = await post(user("admin"), routeB(ws, op), { kind: "dismiss" });
    const second = await answer(await post(user("admin"), routeB(ws, op), { kind: "dismiss" }));
    expect([first.status, second.status, second.error?.code]).toEqual([200, 409, "conflict"]);
    expect(second.error).toHaveProperty("requestId");
    expect([await stateOf(op), await resolutions(op), await audits(op)]).toEqual(["unverified", 1, 1]);
  });
});

describe("a resolution and its audit row", () => {
  it("supersede returns the new operation, links both ways and writes one audit row of ids only", async () => {
    // fails first because: the routes do not exist, or the audit row is missing or carries the text of the person
    const op = await plantOp({ author: user("writer").id });
    const done = await answer(
      await post(user("owner"), routeA(ws, op), {
        kind: "supersede",
        ack_text: "canary-ack-text",
        note: "canary-note",
      }),
    );
    const made = done.data?.new_operation_id as string;
    expect(done.data).toEqual({ operation_id: op, kind: "supersede", new_operation_id: made });
    const links = await fx.admin((client) =>
      client.query(
        `SELECT (SELECT superseded_by_operation_id FROM app.operations WHERE id = $1) AS forward,
           (SELECT supersedes_operation_id FROM app.operations WHERE id = $2) AS back`,
        [op, made],
      ),
    );
    expect(links.rows[0]).toEqual({ forward: made, back: op });
    const rows = await fx.admin((client) =>
      client.query(
        "SELECT resource_kind, actor_ref, metadata FROM app.audit_logs WHERE action = 'operation.resolved' AND resource_id = $1",
        [op],
      ),
    );
    expect(rows.rows).toEqual([
      {
        resource_kind: "operation",
        actor_ref: user("owner").id,
        metadata: { kind: "supersede", new_operation_id: made },
      },
    ]);
  });

  it("no text of the person is in any log line or audit row", async () => {
    // fails first because: the routes do not exist, or the ack text, the note or the link is logged
    const op = await plantOp({ author: user("writer").id });
    const text = `canary-${randomUUID()}`;
    const body = {
      kind: "attest_published",
      ack_text: `${text}-ack`,
      note: `${text}-note`,
      permalink: `https://example.test/${text}`,
    };
    const lines = fx.logged.length;
    expect((await post(user("admin"), routeA(ws, op), body)).status).toBe(200);
    const audit = await fx.admin((client) =>
      client.query("SELECT metadata::text AS m FROM app.audit_logs WHERE resource_id = $1", [op]),
    );
    // The request was logged (so the absence below is a finding about logged lines), and none of them holds the text.
    expect(fx.logged.length).toBeGreaterThan(lines);
    expect(fx.logged.join("\n")).not.toContain(text);
    expect(JSON.stringify(audit.rows)).not.toContain(text);
  });
});

// Feature rows: each kind reaches the state the ledger says, the three refusals share one envelope, and the two bounds of
// R617. The decisions of the definer itself are the rows of its own slice.
// [route, kind, the plant, the body, the state after]
const KINDS: ["A" | "B", string, Partial<Plant>, Record<string, unknown>, string][] = [
  ["A", "attest_published", {}, {}, "published"],
  ["A", "attest_not_executed", {}, { ack_text: "not sent" }, "retry_wait"],
  ["A", "supersede", {}, { ack_text: "again" }, "superseded_after_unknown_outcome"],
  ["A", "confirm_removed", { kind: "delete" }, {}, "published"],
  ["B", "publish_late", { effect: "none" }, {}, "retry_wait"],
  ["B", "reschedule", { effect: "none" }, {}, "cancelled"],
  ["B", "drop", { effect: "none" }, {}, "cancelled"],
  ["B", "dismiss", {}, {}, "unverified"],
];
describe("each kind of resolution", () => {
  it.each(KINDS)(
    "%s %s answers 200 and leaves the operation %s",
    async (route, kind, planted, body, after) => {
      const op = await plantOp({ author: user("writer").id, ...planted });
      const path = (route === "A" ? routeA : routeB)(ws, op);
      const done = await answer(await post(user("admin"), path, { kind, ...body }));
      expect([done.status, await stateOf(op)]).toEqual([200, after]);
      expect(done.data?.new_operation_id === null).toBe(kind !== "supersede");
    },
  );
});

describe("the answers of a refused resolution", () => {
  it("a 400 and a 404 carry the error envelope with a code and a request id (the 409 is the repeat row's)", async () => {
    const op = await plantOp({ author: user("writer").id });
    const answers = [
      await post(user("admin"), routeB(ws, op), { kind: "nonsense" }),
      await post(user("admin"), routeB(ws, randomUUID()), { kind: "dismiss" }),
    ];
    const shapes = await Promise.all(
      answers.map(async (r) => [r.status, Object.keys(((await r.json()) as { error: object }).error).sort()]),
    );
    expect(shapes.map(([status]) => status)).toEqual([400, 404]);
    for (const [, keys] of shapes) expect(keys).toEqual(expect.arrayContaining(["code", "requestId"]));
  });

  it.each([
    ["a note over 2000 characters", { kind: "dismiss", note: "n".repeat(2001) }],
    [
      "a permalink over 2048 characters",
      { kind: "attest_published", permalink: `https://example.test/${"p".repeat(2040)}` },
    ],
  ])("%s is a 400", async (_name, body) => {
    const op = await plantOp({ author: user("writer").id });
    const path = body.kind === "dismiss" ? routeB(ws, op) : routeA(ws, op);
    expect((await post(user("admin"), path, body)).status).toBe(400);
    await untouched(op);
  });
});
