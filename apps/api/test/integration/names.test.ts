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

let fx: Fixture;
let cookie: string;
let orgId: string;
let workspaceId: string;
beforeAll(async () => {
  fx = await startFixture();
  const user = await signedUser(fx, "names-owner");
  cookie = user.cookie;
  orgId = await seedOrganization(fx, user.id);
  workspaceId = await seedWorkspace(fx, orgId);
  await addWorkspaceMember(fx, workspaceId, user.id, "owner");
});
afterAll(() => fx.close());

const send = (path: string, method: string, body: unknown) =>
  fx.request(path, { method, headers: { cookie }, body });
const calls: Array<[string, (name: string) => Promise<Response>]> = [
  ["an organization", (name) => send("/api/v1/organizations", "POST", { name, type: "team" })],
  [
    "a new workspace",
    (name) => send("/api/v1/workspaces", "POST", { organization_id: orgId, name, default_tz: "UTC" }),
  ],
  ["a renamed workspace", (name) => send(workspacePath(workspaceId), "PATCH", { name })],
];
// The characters are built from their code points, so no invisible character sits in this file.
const among = (code: number) => `Acme${String.fromCodePoint(code)}Group`;
const BAD = [
  ["spaces only", "   "],
  ["a NUL character", among(0x0)],
  ["a bidi override", among(0x202e)],
  ["a line separator", among(0x2028)],
] as const;

describe("organization and workspace names", () => {
  it.each(calls.flatMap(([what, call]) => BAD.map(([bad, name]) => [what, bad, name, call] as const)))(
    "%s refuses %s with 400 validation_failed",
    async (_what, _bad, name, call) => {
      const answer = await call(name);
      expect(answer.status).toBe(400);
      expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("validation_failed");
    },
  );

  it("trims a padded name before it is stored and answered", async () => {
    const answer = await send(workspacePath(workspaceId), "PATCH", { name: "  Padded Name  " });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { data: { name: string } }).data.name).toBe("Padded Name");
    expect((await workspaceRow(fx, workspaceId)).name).toBe("Padded Name");
  });
});
