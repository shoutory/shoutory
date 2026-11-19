import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedOrganization, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// The workspace list and create routes: the answers, the derived slug and the refusals the definer does not own (R230,
// R231). Who may see or do what is the floor in route-deny-matrix.test.ts.

let fx: Fixture;
let cookie: string;
let orgId: string;
let ownerId: string;
beforeAll(async () => {
  fx = await startFixture();
  const user = await signedUser(fx, "ws-create-owner");
  cookie = user.cookie;
  ownerId = user.id;
  orgId = await seedOrganization(fx, user.id);
});
afterAll(() => fx.close());

const WORKSPACES = "/api/v1/workspaces";
const create = (body: Record<string, unknown>) =>
  fx.request(WORKSPACES, {
    method: "POST",
    headers: { cookie },
    body: { organization_id: orgId, default_tz: "UTC", ...body },
  });

describe("POST /api/v1/workspaces", () => {
  it("answers 201 with the profile shape, and the new workspace is listed", async () => {
    const answer = await create({ name: "Launch Team", slug: "launch-team", default_tz: "Africa/Cairo" });
    expect(answer.status).toBe(201);
    const { data } = (await answer.json()) as { data: { id: string } };
    expect(data).toEqual({
      id: expect.any(String),
      organization_id: orgId,
      name: "Launch Team",
      slug: "launch-team",
      colour: null,
      default_tz: "Africa/Cairo",
    });
    const listed = await fx.request(WORKSPACES, { headers: { cookie } });
    const rows = ((await listed.json()) as { data: Array<{ id: string; slug: string }> }).data;
    expect(rows.find((row) => row.id === data.id)?.slug).toBe("launch-team");
  });

  it.each([
    ["Hello, World!", "hello-world"],
    ["  --Ünï  Co--  ", "n-co"],
    ["!!!", "workspace"],
    ["a".repeat(80), "a".repeat(63)],
  ])("derives the slug of %j as %j when none is sent", async (name, slug) => {
    const answer = await create({ name });
    const sent = (await answer.json()) as { data: { slug: string } };
    expect(answer.status, JSON.stringify(sent)).toBe(201);
    expect(sent.data.slug).toBe(slug.length > 0 ? slug : "workspace");
  });

  it("answers 409 conflict on a slug already used in the organization", async () => {
    expect((await create({ name: "Clash One", slug: "clash" })).status).toBe(201);
    const second = await create({ name: "Clash Two", slug: "clash" });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("conflict");
  });

  it.each([
    ["an unknown time zone", { name: "x", default_tz: "Mars/Olympus" }],
    ["a name with a NUL character", { name: "bad\u0000name" }],
    ["a slug with capitals and a space", { name: "x", slug: "Bad Slug" }],
  ])("refuses %s with 400", async (_label, body) => {
    expect((await create(body)).status).toBe(400);
  });
});

// A slug that was derived, not sent, is retried with -2, -3, ... when the organization already holds it.
describe("the derived slug of a second workspace with the same name", () => {
  const slugsOf = async (names: string[], organization = orgId) => {
    const answers = [];
    for (const name of names) {
      const answer = await create({ name, organization_id: organization });
      expect(answer.status, name).toBe(201);
      answers.push(((await answer.json()) as { data: { slug: string } }).data.slug);
    }
    return answers;
  };
  const ARABIC = ["عميل أ", "عميل ب"];

  it("gives two Arabic-named clients distinct slugs: workspace, then workspace-2", async () => {
    expect(await slugsOf(ARABIC, await seedOrganization(fx, ownerId))).toEqual(["workspace", "workspace-2"]);
  });

  it("cuts a 63-character base so the suffix still fits the slug pattern", async () => {
    const slugs = await slugsOf(["a".repeat(70), "a".repeat(70)], await seedOrganization(fx, ownerId));
    expect(slugs).toEqual(["a".repeat(63), `${"a".repeat(61)}-2`]);
  });

  it("gives two concurrent creates of the same name distinct slugs", async () => {
    const organization = await seedOrganization(fx, ownerId);
    const both = await Promise.all(
      [1, 2].map(() => create({ name: "Race Client", organization_id: organization })),
    );
    expect(both.map((answer) => answer.status)).toEqual([201, 201]);
    const rows = await Promise.all(
      both.map((answer) => answer.json() as Promise<{ data: { slug: string } }>),
    );
    expect(rows.map((row) => row.data.slug).sort()).toEqual(["race-client", "race-client-2"]);
  });

  it("still answers limit_reached at 100 workspaces", async () => {
    const organization = await seedOrganization(fx, ownerId);
    await fx.admin((client) =>
      client.query(
        `INSERT INTO app.workspaces (organization_id, name, slug)
         SELECT $1, 'w' || g, 'w' || g FROM generate_series(1, 100) AS g`,
        [organization],
      ),
    );
    const full = await create({ name: "One Too Many", organization_id: organization });
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe("limit_reached");
  });
});
