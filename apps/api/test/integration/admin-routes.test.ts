import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { signedUser } from "../support/tenancy.js";
import { cookieOf, type Fixture, PASSWORD, startFixture } from "./auth/harness.js";

// The instance admin routes (Z-03 and the sign-up switch). Only an instance admin reaches them: anyone else is told
// the route does not exist; a write needs a recent step-up and leaves one audit row.
const FLAGS = "/api/v1/admin/flags";
const SETTINGS = "/api/v1/admin/settings";
const SIGNUP = `${SETTINGS}/signup_enabled`;
const override = (key: string) => `${FLAGS}/${key}/override`;
const OFF = "admin-flag-off";
const SET = "admin-flag-set";
const NEG = "admin-flag-neg";
const OLD = "admin-flag-old";

let fx: Fixture;
let adminEmail: string;
let outsider: { id: string; cookie: string };
let storageDir: string;
// The real driver, counting the objects the storage check probe writes.
let probes = 0;
beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "shoutory-admin-storage-"));
  const real = createFsDriver(storageDir);
  fx = await startFixture({
    storage: {
      ...real,
      put: (...args) => {
        probes++;
        return real.put(...args);
      },
    },
  });
  const first = await signedUser(fx, "admin-first");
  adminEmail = (
    await fx.admin((client) => client.query('SELECT email FROM auth."user" WHERE id = $1', [first.id]))
  ).rows[0].email;
  outsider = await signedUser(fx, "admin-outsider");
  await fx.admin(async (client) => {
    await client.query(
      `INSERT INTO app.feature_flags (key, description, owner, remove_by, default_on) VALUES
         ('${OFF}', 'off by default', 'admin-owner', current_date + 90, false),
         ('${SET}', 'set on for the instance', 'admin-owner', current_date + 90, false),
         ('${NEG}', 'on by default, set off', 'admin-owner', current_date + 90, true),
         ('${OLD}', 'past its date', 'admin-owner', date '2000-01-01', false)`,
    );
    await client.query(
      `INSERT INTO app.feature_flag_overrides (flag_key, scope, scope_id, "on") VALUES
         ('${SET}', 'instance', NULL, true), ('${NEG}', 'instance', NULL, false)`,
    );
  });
});
afterAll(async () => {
  await fx.close();
  await rm(storageDir, { recursive: true, force: true });
});

/** A fresh sign-in of the instance admin: its step-up is recent. */
const login = async (): Promise<string> =>
  cookieOf(await fx.request("/api/auth/sign-in/email", { body: { email: adminEmail, password: PASSWORD } }));
const send = (method: "GET" | "PUT", path: string, cookie: string, body?: unknown) =>
  fx.request(path, { method, headers: { cookie }, ...(body === undefined ? {} : { body }) });
const errorCode = async (answer: Response) =>
  ((await answer.json()) as { error?: { code: string } }).error?.code;
const overrideRows = (key: string) =>
  fx.admin(async (client) =>
    Number(
      (
        await client.query(
          "SELECT count(*) AS n FROM app.feature_flag_overrides WHERE flag_key = $1 AND scope = 'instance'",
          [key],
        )
      ).rows[0].n,
    ),
  );
const auditRows = (action: string, resource: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query("SELECT request_id FROM app.audit_logs WHERE action = $1 AND resource_id = $2", [
          action,
          resource,
        ])
      ).rows,
  );
const storedSignup = () =>
  fx.admin(
    async (client) =>
      (await client.query("SELECT value FROM app.instance_settings WHERE key = 'signup_enabled'")).rows,
  );

const ROUTES: ["GET" | "PUT", string, unknown][] = [
  ["GET", FLAGS, undefined],
  ["GET", SETTINGS, undefined],
  ["PUT", override(OFF), { on: true }],
  ["PUT", SIGNUP, { value: false }],
];

describe("admin routes: who may reach them", () => {
  it.each(ROUTES)(
    "%s %s answers 401 with no session and 404 to a user who is not an instance admin",
    async (method, path, body) => {
      expect((await send(method, path, "", body)).status).toBe(401);
      const answer = await send(method, path, outsider.cookie, body);
      expect([answer.status, await errorCode(answer)]).toEqual([404, "not_found"]);
      if (method === "PUT") expect(await overrideRows(OFF)).toBe(0);
    },
  );

  it.each([
    ["PUT", override(OFF), { on: true }],
    ["PUT", SIGNUP, { value: false }],
  ] as const)("%s %s answers 404 to a non-admin whose step-up is stale", async (method, path, body) => {
    await fx.admin((client) =>
      client.query("UPDATE app.session_step_ups SET at = at - interval '11 minutes' WHERE user_id = $1", [
        outsider.id,
      ]),
    );
    const answer = await send(method, path, outsider.cookie, body);
    expect([answer.status, await errorCode(answer)]).toEqual([404, "not_found"]);
  });

  it.each([
    ["PUT", override(OFF), { on: true }],
    ["PUT", SIGNUP, { value: false }],
  ] as const)(
    "%s %s without a recent step-up answers 403 step_up_required and changes nothing",
    async (method, path, body) => {
      const cookie = await login();
      await fx.admin((client) =>
        client.query(
          `UPDATE app.session_step_ups SET at = at - interval '11 minutes'
         WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
          [adminEmail],
        ),
      );
      const answer = await send(method, path, cookie, body);
      expect([answer.status, await errorCode(answer)]).toEqual([403, "step_up_required"]);
      expect(await overrideRows(OFF)).toBe(0);
      expect(await storedSignup()).toEqual([{ value: true }]);
    },
  );
});

describe("admin routes: what an instance admin does", () => {
  it("sets and clears an instance override, each leaving one audit row with the request id", async () => {
    const cookie = await login();
    const set = await send("PUT", override(OFF), cookie, { on: true });
    expect(set.status).toBe(200);
    expect(await overrideRows(OFF)).toBe(1);
    expect(await auditRows("flag.override_set", OFF)).toEqual([
      { request_id: set.headers.get("x-request-id") },
    ]);
    const cleared = await send("PUT", override(OFF), cookie, { on: null });
    expect(cleared.status).toBe(200);
    expect(await overrideRows(OFF)).toBe(0);
    expect(await auditRows("flag.override_set", OFF)).toHaveLength(2);
  });

  it.each([[OLD], ["admin-flag-missing"]])(
    "an override of the unknown or retired flag %s answers 400 validation_failed",
    async (key) => {
      const answer = await send("PUT", override(key), await login(), { on: true });
      expect([answer.status, await errorCode(answer)]).toEqual([400, "validation_failed"]);
    },
  );

  it("changes the sign-up switch, reads it back and leaves one audit row", async () => {
    const cookie = await login();
    const changed = await send("PUT", SIGNUP, cookie, { value: false });
    expect(changed.status).toBe(200);
    expect(await storedSignup()).toEqual([{ value: false }]);
    expect(await auditRows("instance.setting_set", "signup_enabled")).toEqual([
      { request_id: changed.headers.get("x-request-id") },
    ]);
    const read = await send("GET", SETTINGS, cookie);
    expect(await read.json()).toEqual({ data: [{ key: "signup_enabled", value: false }] });
  });

  it("lists every flag with its effective instance state through the loader", async () => {
    const answer = await send("GET", FLAGS, await login());
    expect(answer.status).toBe(200);
    const rows = ((await answer.json()) as { data?: Record<string, unknown>[] }).data ?? [];
    expect(rows.map((row) => [row.key, row.default_on, row.instance_override, row.effective])).toEqual(
      expect.arrayContaining([
        [OFF, false, null, false],
        [SET, false, true, true],
        [NEG, true, false, false],
        [OLD, false, null, false],
      ]),
    );
    expect(rows.find((row) => row.key === OLD)).toMatchObject({
      owner: "admin-owner",
      remove_by: "2000-01-01",
    });
  });
});

describe("admin storage check route", () => {
  const CHECK = "/api/v1/admin/storage/check";
  const post = (cookie: string) => fx.request(CHECK, { method: "POST", headers: { cookie } });
  const staleStepUp = (where: string, param: string) =>
    fx.admin((client) =>
      client.query(`UPDATE app.session_step_ups SET at = at - interval '11 minutes' WHERE ${where}`, [param]),
    );
  const auditCount = async () =>
    Number((await fx.admin((client) => client.query("SELECT count(*) AS n FROM app.audit_logs"))).rows[0].n);

  it("answers 401 with no session and 404 to a user who is not an instance admin, writing no probe", async () => {
    const before = probes;
    expect((await post("")).status).toBe(401);
    const answer = await post(outsider.cookie);
    expect([answer.status, await errorCode(answer)]).toEqual([404, "not_found"]);
    await staleStepUp("user_id = $1", outsider.id);
    const stale = await post(outsider.cookie);
    expect([stale.status, await errorCode(stale)]).toEqual([404, "not_found"]);
    expect(probes).toBe(before);
  });

  it("answers 403 step_up_required to an admin without a recent step-up, writing no probe", async () => {
    const cookie = await login();
    await staleStepUp(`user_id = (SELECT id FROM auth."user" WHERE email = $1)`, adminEmail);
    const before = probes;
    const answer = await post(cookie);
    expect([answer.status, await errorCode(answer)]).toEqual([403, "step_up_required"]);
    expect(probes).toBe(before);
  });

  it("runs the probe for an admin with a fresh step-up and records no audit row", async () => {
    const cookie = await login();
    const rows = await auditCount();
    const before = probes;
    const answer = await post(cookie);
    expect(answer.status).toBe(200);
    const { data } = (await answer.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ driver: "fs", writable: true, readable: true, failure: null });
    expect(data.free_bytes).toBeGreaterThan(0);
    expect(probes).toBe(before + 1);
    expect(await auditCount()).toBe(rows);
  });
});
