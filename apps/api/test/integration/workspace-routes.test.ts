import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsDriver } from "../../src/storage/fs-driver.js";
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
let ownerId: string;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-workspace-routes-"));
  fx = await startFixture({
    storage: createFsDriver(dir),
    // An archived workspace must refuse before any fetch, so a fetch fails the test.
    mediaImportFetch: () => Promise.reject(new Error("an archived workspace fetched an import")),
  });
  const user = await signedUser(fx, "profile-owner");
  cookie = user.cookie;
  ownerId = user.id;
  orgId = await seedOrganization(fx, user.id);
  workspaceId = await seedWorkspace(fx, orgId);
  await addWorkspaceMember(fx, workspaceId, user.id, "owner");
});
afterAll(async () => {
  await fx.close();
  await rm(dir, { recursive: true, force: true });
});

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
  it("answers GET and PATCH with exactly the eight allowlisted fields", async () => {
    const answers = [
      await patch({ name: "Allowlist check", colour: "#112233" }),
      await fx.request(workspacePath(workspaceId), { headers: { cookie } }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      const { data } = (await answer.json()) as { data: Record<string, unknown> };
      expect(Object.keys(data).sort()).toEqual([
        "archived_at",
        "avatar",
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

const fresh = async () => {
  const id = await seedWorkspace(fx, orgId);
  await addWorkspaceMember(fx, id, ownerId, "owner");
  return id;
};
const send = (
  method: string,
  path: string,
  body?: unknown,
  who = cookie,
  extra: Record<string, string> = {},
) =>
  fx.request(path, { method, headers: { cookie: who, ...extra }, ...(body === undefined ? {} : { body }) });
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; details?: { reason?: string } } }).error;

describe("archive and unarchive routes", () => {
  it("archive answers archived_at, unarchive clears it, and a viewer or an outsider is refused", async () => {
    const id = await fresh();
    const viewer = await signedUser(fx, "archive-viewer");
    await addWorkspaceMember(fx, id, viewer.id, "viewer");
    const outsider = await signedUser(fx, "archive-outsider");
    expect((await send("POST", `${workspacePath(id)}/archive`, undefined, viewer.cookie)).status).toBe(403);
    expect((await send("POST", `${workspacePath(id)}/archive`, undefined, outsider.cookie)).status).toBe(404);
    const archived = await send("POST", `${workspacePath(id)}/archive`);
    expect(archived.status).toBe(200);
    expect(
      ((await archived.json()) as { data: { archived_at: string | null } }).data.archived_at,
    ).not.toBeNull();
    const restored = await send("POST", `${workspacePath(id)}/unarchive`);
    expect(((await restored.json()) as { data: { archived_at: string | null } }).data.archived_at).toBeNull();
    expect((await workspaceRow(fx, id)).archived_at).toBeNull();
  });
});

describe("an archived workspace is read-only", () => {
  it.each([
    ["PATCH the profile", "PATCH", "", { name: "renamed" }],
    ["PATCH the avatar", "PATCH", "", { avatar: null }],
    [
      "invite a member",
      "POST",
      "/invitations",
      { email: "archived-invite@example.test", role_key: "editor" },
    ],
    ["revoke an invitation", "DELETE", `/invitations/${randomUUID()}`, undefined],
    ["leave", "POST", "/members/me/leave", undefined],
    ["delete a medium", "DELETE", `/media/${randomUUID()}`, undefined],
    [
      "ask for part URLs",
      "POST",
      `/media/${randomUUID()}/parts`,
      { parts: [{ number: 1, sha256: "a".repeat(64) }] },
    ],
    ["import by URL", "POST", "/media/import", { url: "https://example.test/a.png" }],
  ])("%s answers 409 conflict workspace_archived and changes nothing", async (_label, method, tail, body) => {
    const id = await fresh();
    expect((await send("POST", `${workspacePath(id)}/archive`)).status).toBe(200);
    const before = await workspaceRow(fx, id);
    const answer = await send(method, `${workspacePath(id)}${tail}`, body);
    expect(answer.status).toBe(409);
    expect(await errorOf(answer)).toMatchObject({
      code: "conflict",
      details: { reason: "workspace_archived" },
    });
    expect(await workspaceRow(fx, id)).toEqual(before);
  });

  it("reads still answer and unarchive lifts the refusal", async () => {
    const id = await fresh();
    expect((await send("POST", `${workspacePath(id)}/archive`)).status).toBe(200);
    expect((await send("GET", workspacePath(id))).status).toBe(200);
    expect((await send("GET", `${workspacePath(id)}/members`)).status).toBe(200);
    await send("POST", `${workspacePath(id)}/unarchive`);
    expect((await send("PATCH", workspacePath(id), { name: "back again" })).status).toBe(200);
  });
});

describe("the create key and the template", () => {
  const v7 = async () => (await fx.admin((c) => c.query("SELECT uuidv7()::text AS id"))).rows[0].id as string;
  const body = (name: string) => ({ organization_id: orgId, name, default_tz: "UTC" });
  const create = (path: string, payload: unknown, key: string, who = cookie) =>
    send("POST", path, payload, who, { "idempotency-key": key });

  it("a workspace create retried with the same key answers 201 then 200 with the same row", async () => {
    const key = await v7();
    const first = await create("/api/v1/workspaces", body("keyed"), key);
    const again = await create("/api/v1/workspaces", body("keyed"), key);
    expect([first.status, again.status]).toEqual([201, 200]);
    const [a, b] = [await first.json(), await again.json()];
    expect(b).toEqual(a);
    expect((a as { data: { id: string } }).data.id).toBe(key);
  });

  it("the same key from another user answers 422 idempotency_key_reused and says nothing of the row", async () => {
    const key = await v7();
    const payload = { name: "keyed-org", type: "team" };
    expect((await create("/api/v1/organizations", payload, key)).status).toBe(201);
    const other = await signedUser(fx, "key-thief");
    const answer = await create("/api/v1/organizations", payload, key, other.cookie);
    expect(answer.status).toBe(422);
    const error = await errorOf(answer);
    expect(error).toMatchObject({
      code: "unprocessable_content",
      details: { reason: "idempotency_key_reused" },
    });
    expect(JSON.stringify(error)).not.toContain(key);
  });

  it.each([randomUUID(), "not-a-uuid"])("a key that is not a UUIDv7 (%s) answers 400", async (key) => {
    expect((await create("/api/v1/workspaces", body("bad-key"), key)).status).toBe(400);
  });

  it("a template of another organization answers 404 and creates nothing", async () => {
    const stranger = await signedUser(fx, "template-stranger");
    const foreign = await seedWorkspace(fx, await seedOrganization(fx, stranger.id));
    const name = "stolen-template";
    const answer = await send("POST", "/api/v1/workspaces", {
      organization_id: orgId,
      name,
      template_workspace_id: foreign,
    });
    expect(answer.status).toBe(404);
    const made = await fx.admin((c) => c.query("SELECT id FROM app.workspaces WHERE name = $1", [name]));
    expect(made.rows).toEqual([]);
  });
});

describe("GET /api/v1/workspaces", () => {
  it("lists archived_at, avatar and organization_type with each workspace", async () => {
    const id = await fresh();
    await send("POST", `${workspacePath(id)}/archive`);
    const listed = (await (await send("GET", "/api/v1/workspaces?limit=100")).json()) as {
      data: Record<string, unknown>[];
    };
    expect(listed.data.find((row) => row.id === id)).toMatchObject({
      archived_at: expect.any(String),
      avatar: null,
      organization_type: "team",
    });
  });

  it("pages past 100 workspaces by next_cursor, every workspace once", async () => {
    const reader = await signedUser(fx, "workspace-pager");
    const orgs = [await seedOrganization(fx, reader.id), await seedOrganization(fx, reader.id)];
    await fx.admin((client) =>
      client.query(
        `INSERT INTO app.workspaces (organization_id, name, slug)
           SELECT o, 'paged-' || g, 'paged-' || g FROM unnest($1::uuid[]) o, generate_series(1, 55) g`,
        [orgs],
      ),
    );
    const page = async (cursor?: string) => {
      const query = cursor ? `&cursor=${cursor}` : "";
      const answer = await fx.request(`/api/v1/workspaces?limit=100${query}`, {
        headers: { cookie: reader.cookie },
      });
      return (await answer.json()) as { data: { id: string }[]; meta: { next_cursor: string | null } };
    };
    const first = await page();
    expect(first.data).toHaveLength(100);
    expect(first.meta.next_cursor).toBe(first.data[99]?.id);
    const second = await page(first.meta.next_cursor ?? undefined);
    expect(second.data).toHaveLength(10);
    expect(second.meta.next_cursor).toBeNull();
    expect(new Set([...first.data, ...second.data].map((row) => row.id)).size).toBe(110);
  });
});
