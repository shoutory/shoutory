import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedOrganization, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const post = (cookie: string, path: string, body: Record<string, unknown>) =>
  fx.request(path, { method: "POST", headers: { cookie }, body });

describe("the per-user creation limit", () => {
  it("refuses the 11th creation across both routes with 429 and a Retry-After in seconds", async () => {
    const user = await signedUser(fx, "tc-throttle");
    const org = await seedOrganization(fx, user.id);
    for (let n = 0; n < 5; n++) {
      const workspace = await post(user.cookie, "/api/v1/workspaces", {
        organization_id: org,
        name: `Space ${n}`,
        default_tz: "UTC",
      });
      expect(workspace.status).toBe(201);
      const organization = await post(user.cookie, "/api/v1/organizations", {
        name: `Org ${n}`,
        type: "team",
      });
      expect(organization.status).toBe(201);
    }
    for (const [path, body] of [
      ["/api/v1/workspaces", { organization_id: org, name: "One too many", default_tz: "UTC" }],
      ["/api/v1/organizations", { name: "One too many", type: "team" }],
    ] as const) {
      const refused = await post(user.cookie, path, body);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("too_many_requests");
    }
    const count = await fx.admin(
      async (client) =>
        (await client.query("SELECT count(*)::int AS n FROM app.workspaces WHERE name = 'One too many'"))
          .rows[0].n,
    );
    expect(count).toBe(0);
  });

  it("another user's creation still succeeds after the first is limited", async () => {
    const other = await signedUser(fx, "tc-throttle-other");
    const answer = await post(other.cookie, "/api/v1/organizations", { name: "Fresh", type: "team" });
    expect(answer.status).toBe(201);
  });
});
