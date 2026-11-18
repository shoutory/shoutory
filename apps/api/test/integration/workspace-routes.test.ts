import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  seedOrganization,
  seedWorkspace,
  signedUser,
  workspacePath,
  workspaceRow,
} from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// The profile routes of a workspace: what PATCH accepts and refuses (R214) and what the answers hold (R219).

let fx: Fixture;
let cookie: string;
let orgId: string;
let workspaceId: string;
beforeAll(async () => {
  fx = await startFixture();
  const user = await signedUser(fx, "profile-owner");
  cookie = user.cookie;
  orgId = await seedOrganization(fx, user.id);
  workspaceId = await seedWorkspace(fx, orgId);
  await addWorkspaceMember(fx, workspaceId, user.id, "owner");
});
afterAll(() => fx.close());

const patch = (body: unknown, id = workspaceId) =>
  fx.request(workspacePath(id), { method: "PATCH", headers: { cookie }, body });
const codeOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe("PATCH /api/v1/workspaces/{workspace_id}", () => {
  it.each([
    ["an unknown time zone", { default_tz: "Mars/Olympus" }],
    ["a colour that is not #rrggbb", { colour: "red" }],
    ["an empty body", {}],
    ["a name with a NUL character", { name: "bad\u0000name" }],
    ["a slug with capitals and a space", { slug: "Bad Slug" }],
  ])("refuses %s with 400 validation_failed and changes nothing", async (_label, body) => {
    const before = await workspaceRow(fx, workspaceId);
    const answer = await patch(body);
    expect(answer.status).toBe(400);
    expect(await codeOf(answer)).toBe("validation_failed");
    expect(await workspaceRow(fx, workspaceId)).toEqual(before);
  });

  it.each(["UTC", "Africa/Cairo"])("accepts the zone %s", async (zone) => {
    const answer = await patch({ default_tz: zone });
    expect(answer.status).toBe(200);
    expect((await workspaceRow(fx, workspaceId)).default_tz).toBe(zone);
  });

  it("answers a slug that another workspace of the organization holds with 409 conflict", async () => {
    const taken = await seedWorkspace(fx, orgId, "taken-slug");
    const answer = await patch({ slug: "taken-slug" });
    expect(answer.status).toBe(409);
    expect(await codeOf(answer)).toBe("conflict");
    expect((await workspaceRow(fx, taken)).slug).toBe("taken-slug");
  });
});

describe("workspace profile answers", () => {
  it("answers GET and PATCH with exactly the six allowlisted fields", async () => {
    const answers = [
      await patch({ name: "Allowlist check", colour: "#112233" }),
      await fx.request(workspacePath(workspaceId), { headers: { cookie } }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      const { data } = (await answer.json()) as { data: Record<string, unknown> };
      expect(Object.keys(data).sort()).toEqual([
        "colour",
        "default_tz",
        "id",
        "name",
        "organization_id",
        "slug",
      ]);
      expect(data.name).toBe("Allowlist check");
    }
  });

  it("reads the caller's own workspace by its uppercase id", async () => {
    const answer = await fx.request(workspacePath(workspaceId.toUpperCase()), { headers: { cookie } });
    expect(answer.status).toBe(200);
  });

  it("answers a path id that is not a UUID with 400 validation_failed", async () => {
    const answer = await fx.request("/api/v1/workspaces/not-a-uuid", { headers: { cookie } });
    expect(answer.status).toBe(400);
    expect(await codeOf(answer)).toBe("validation_failed");
  });
});
