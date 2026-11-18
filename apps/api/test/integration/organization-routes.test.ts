import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addOrganizationMember, seedOrganization, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// The organization list and create routes: the answers, the bounds and the pages (R229, R230). Who may see or do what
// is the floor in route-deny-matrix.test.ts.

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const ORGS = "/api/v1/organizations";
const create = (cookie: string, body: unknown) =>
  fx.request(ORGS, { method: "POST", headers: { cookie }, body });
const fetchList = async (cookie: string, query = "") => {
  const answer = await fx.request(`${ORGS}${query}`, { headers: { cookie } });
  const body = (await answer.json()) as { data: Array<{ id: string }>; meta: { next_cursor: string | null } };
  return { status: answer.status, body };
};

describe("POST /api/v1/organizations", () => {
  it("answers 201 with the organization, makes the caller its owner and lists it with no workspace", async () => {
    const user = await signedUser(fx, "org-create");
    const answer = await create(user.cookie, { name: "Acme Agency", type: "agency" });
    expect(answer.status).toBe(201);
    const { data } = (await answer.json()) as { data: Record<string, string> };
    expect(data).toEqual({
      id: expect.any(String),
      name: "Acme Agency",
      type: "agency",
      slug: expect.any(String),
    });
    const role = await fx.admin(
      async (client) =>
        (
          await client.query(
            "SELECT org_role FROM app.organization_members WHERE organization_id = $1 AND user_id = $2",
            [data.id, user.id],
          )
        ).rows[0]?.org_role,
    );
    expect(role).toBe("owner");
    expect((await fetchList(user.cookie)).body.data).toEqual([data]);
  });

  it.each([
    ["a name with a NUL character", { name: "bad\u0000name", type: "team" }],
    ["an empty name", { name: "", type: "team" }],
    ["a type outside the list", { name: "ok", type: "enterprise" }],
    ["no type", { name: "ok" }],
  ])("refuses %s with 400", async (_label, body) => {
    const user = await signedUser(fx, "org-bad-body");
    expect((await create(user.cookie, body)).status).toBe(400);
  });
});

describe("GET /api/v1/organizations", () => {
  it.each(["0", "101", "abc", "0x10", "1e1", "5.0", "1000", "-1"])(
    "refuses limit=%s with 400",
    async (limit) => {
      const user = await signedUser(fx, "org-limit-query");
      expect((await fetchList(user.cookie, `?limit=${limit}`)).status).toBe(400);
    },
  );

  it("pages by the last id: next_cursor on a full page, null on a short one", async () => {
    const user = await signedUser(fx, "org-pages");
    const owner = await signedUser(fx, "org-pages-owner");
    const ids = [] as string[];
    for (let i = 0; i < 3; i++) ids.push(await seedOrganization(fx, owner.id));
    for (const id of ids) await addOrganizationMember(fx, id, user.id, "member");
    const first = await fetchList(user.cookie, "?limit=2");
    const cursor = first.body.meta.next_cursor;
    expect(first.body.data).toHaveLength(2);
    expect(cursor).toBe(first.body.data[1]?.id);
    const second = await fetchList(user.cookie, `?limit=2&cursor=${cursor}`);
    expect(second.body.data.map((row: { id: string }) => row.id)).toEqual([[...ids].sort()[2]]);
    expect(second.body.meta.next_cursor).toBeNull();
  });
});
