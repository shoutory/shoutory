import { randomUUID } from "node:crypto";
import { withSystem } from "@shoutory/db/context/system";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// The reader's own notices, newest first, one page at a time: the list a person opens from the card on the screen.
type User = { id: string; cookie: string };
type Row = Record<string, unknown>;
let fx: Fixture;
let ws: string;
let other: string;
const users: Record<string, User> = {};
const MISSING = "019a0000-0000-7000-8000-000000000000";

const list = (workspace: string, who: User | undefined, query = "") =>
  fx.request(`/api/v1/workspaces/${workspace}/notifications${query}`, {
    headers: who === undefined ? {} : { cookie: who.cookie },
  });
const pageOf = async (answer: Response) => {
  expect(answer.status).toBe(200);
  return (await answer.json()) as { data: Row[]; meta: { next_cursor: string | null } };
};
async function notice(workspace: string, who: User, kind: string, level: string, vars = {}): Promise<string> {
  const subject = randomUUID();
  await withSystem(fx.db.pool("worker"), "ledger", (tx) =>
    tx.query("SELECT app.notice_create($1, $2, $3, $4, $5, $6::jsonb)", [
      workspace,
      who.id,
      kind,
      subject,
      level,
      JSON.stringify(vars),
    ]),
  );
  return subject;
}

beforeAll(async () => {
  fx = await startFixture();
  for (const name of ["owner", "admin", "editor", "viewer", "outsider", "foreign"]) {
    users[name] = await signedUser(fx, `ntc-${name}`);
  }
  ws = await seedWorkspace(fx, await seedOrganization(fx, users.owner?.id ?? ""));
  other = await seedWorkspace(fx, await seedOrganization(fx, users.foreign?.id ?? ""));
  for (const [name, role] of [
    ["owner", "owner"],
    ["admin", "admin"],
    ["editor", "editor"],
    ["viewer", "viewer"],
  ] as const) {
    await addWorkspaceMember(fx, ws, users[name]?.id ?? "", role);
  }
  await addWorkspaceMember(fx, other, users.foreign?.id ?? "", "owner");
}, 60_000);
afterAll(() => fx.close());

const as = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};

describe("GET /api/v1/workspaces/{workspace_id}/notifications", () => {
  it("each reader sees only their own notices of this workspace, and no other workspace's", async () => {
    const mine = [
      await notice(ws, as("admin"), "token_expiry", "7d", { name: "Shop page", days: 7 }),
      await notice(ws, as("admin"), "needs_human", "escalation_0", { name: "Shop page" }),
    ];
    const theirs = await notice(ws, as("owner"), "token_expiry", "14d");
    const abroad = await notice(other, as("foreign"), "token_expiry", "1d");
    const adminSees = await pageOf(await list(ws, as("admin")));
    expect(adminSees.data.map((row) => row.subject_id)).toEqual([mine[1], mine[0]]);
    expect(adminSees.data.map((row) => [row.kind, row.level])).toEqual([
      ["needs_human", "escalation_0"],
      ["token_expiry", "7d"],
    ]);
    const ownerSees = await pageOf(await list(ws, as("owner")));
    expect(ownerSees.data.map((row) => row.subject_id)).toEqual([theirs]);
    expect((await pageOf(await list(ws, as("editor")))).data).toEqual([]);
    expect((await pageOf(await list(other, as("foreign")))).data.map((row) => row.subject_id)).toEqual([
      abroad,
    ]);
  });

  it("answers the allowlisted fields only, with the stored variables and a null read time", async () => {
    const subject = await notice(ws, as("viewer"), "held_media", "held", {
      name: "Shop page",
      access_token: "list-token-1",
    });
    const [row] = (await pageOf(await list(ws, as("viewer")))).data;
    expect(Object.keys(row ?? {}).sort()).toEqual(
      ["created_at", "id", "kind", "level", "read_at", "subject_id", "vars"].sort(),
    );
    expect(row).toMatchObject({ subject_id: subject, kind: "held_media", level: "held", read_at: null });
    expect(row?.vars).toEqual({ name: "Shop page" });
    expect(JSON.stringify(row)).not.toContain("list-token-1");
  });
});

describe("the pages of the notices list and who may ask for them", () => {
  it("pages newest first by cursor, with no row twice and none lost", async () => {
    const reader = as("editor");
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push(await notice(ws, reader, "token_expiry", `l${i}`));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const answer = await pageOf(await list(ws, reader, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`));
      seen.push(...answer.data.map((row) => String(row.subject_id)));
      cursor = answer.meta.next_cursor;
    }
    expect(seen).toEqual([...made].reverse());
    expect(cursor).toBeNull();
  });

  it("a cursor that names another reader's notice gives an empty page", async () => {
    const [foreign] = (await pageOf(await list(other, as("foreign")))).data;
    const answer = await pageOf(await list(ws, as("owner"), `?cursor=${foreign?.id}`));
    expect(answer.data).toEqual([]);
  });

  it.each(["limit=0", "limit=101", "limit=abc", "cursor=not-a-uuid", "extra=1"])(
    "refuses the query %s with 400",
    async (query) => {
      expect((await list(ws, as("owner"), `?${query}`)).status).toBe(400);
    },
  );

  it("refuses no session with 401, and a non-member or another workspace's member with the 404 of a missing workspace", async () => {
    expect((await list(ws, undefined)).status).toBe(401);
    const shape = async (answer: Response) => {
      const { error } = (await answer.json()) as { error: { code: string; message: string } };
      return [answer.status, error.code, error.message];
    };
    const missing = await shape(await list(MISSING, as("outsider")));
    expect(missing[0]).toBe(404);
    for (const who of [as("outsider"), as("foreign")]) {
      expect(await shape(await list(ws, who))).toEqual(missing);
    }
  });
});
