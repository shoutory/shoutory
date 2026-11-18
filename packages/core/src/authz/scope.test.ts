import { describe, expect, it } from "vitest";
import type { Permission } from "./matrix.js";

// The module is loaded inside the tests so that a missing scope module fails each case with its own reason.
const load = () => import("./scope.js");

const WORKSPACE = "0198c0de-0000-7000-8000-000000000001";
const ORGANIZATION = "0198c0de-0000-7000-8000-000000000002";
const OTHER = "0198c0de-0000-7000-8000-000000000003";
const PRINCIPAL = "0198c0de-0000-7000-8000-000000000004";

const rows = (roleKey: string) => [
  { workspace_id: WORKSPACE, organization_id: ORGANIZATION, role_key: roleKey },
  { workspace_id: OTHER, organization_id: ORGANIZATION, role_key: "owner" },
];

describe("mintScope", () => {
  it.each<[string, string, Permission | undefined, "granted" | "forbidden"]>([
    ["editor", "posts.edit", "posts.edit", "granted"],
    ["editor", "settings.manage", "settings.manage", "forbidden"],
    ["viewer", "no permission asked (membership only)", undefined, "granted"],
    ["admin", "settings.manage", "settings.manage", "granted"],
    ["admin", "workspace.danger", "workspace.danger", "forbidden"],
    ["owner", "workspace.danger", "workspace.danger", "granted"],
    ["custom-role", "posts.view", "posts.view", "forbidden"],
  ])("a %s asking for %s is %s", async (roleKey, _label, permission, expected) => {
    const { mintScope } = await load();
    expect(mintScope(rows(roleKey), PRINCIPAL, WORKSPACE, permission).kind).toBe(expected);
  });

  it.each([
    ["a workspace the caller does not reach", rows("owner"), crypto.randomUUID()],
    ["no resolved rows at all", [], WORKSPACE],
  ])("%s is not_found, never forbidden", async (_label, resolved, target) => {
    const { mintScope } = await load();
    expect(mintScope(resolved, PRINCIPAL, target, "posts.view").kind).toBe("not_found");
  });

  it("a granted scope names the workspace and its organization taken from the resolved row", async () => {
    const { mintScope } = await load();
    const result = mintScope(rows("editor"), PRINCIPAL, WORKSPACE, "posts.edit");
    if (result.kind !== "granted") throw new Error("expected a grant");
    expect(result.scope).toMatchObject({ workspaceId: WORKSPACE, organizationId: ORGANIZATION });
  });
});
