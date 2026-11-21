import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  seedOrganization,
  seedWorkspace,
  signedUser,
  userIdOf,
} from "../../support/tenancy.js";
import { type Enrolled, type Fixture, type Jar, PASSWORD, startFixture, totpAt } from "./harness.js";

// R489: an account with the second factor on opens a `step_up` route only with a totp step-up; a password check
// made later is not enough. One row per route family: the auth paths, a member route and an instance admin route.
let fx: Fixture;
let workspace: string;
let viewerId: string;
// The first verified user is the instance admin, so the admin row uses it.
let instanceAdmin: Enrolled;
const FLAG = "second-factor-flag";

beforeAll(async () => {
  fx = await startFixture();
  instanceAdmin = await fx.enrolled("second-factor-admin-1@example.test");
  const orgOwner = await signedUser(fx, "second-factor-org");
  workspace = await seedWorkspace(fx, await seedOrganization(fx, orgOwner.id));
  viewerId = (await signedUser(fx, "second-factor-viewer")).id;
  await addWorkspaceMember(fx, workspace, viewerId, "viewer");
  await fx.admin((client) =>
    client.query(
      `INSERT INTO app.feature_flags (key, description, owner, remove_by, default_on)
       VALUES ($1, 'for the second-factor step-up row', 'step-up-owner', current_date + 90, false)`,
      [FLAG],
    ),
  );
}, 60_000);
afterAll(() => fx.close());

const send = (jar: Jar, method: string, path: string, body?: object) =>
  fx.request(path, { method, headers: jar.header, ...(body ? { body } : {}) });
const refusalOf = async (answer: Response) => {
  const { error } = (await answer.json()) as { error?: { code: string; details?: Record<string, string> } };
  return { code: error?.code, details: error?.details };
};

const ROWS = [
  [
    "auth path",
    async (tag: string) => fx.enrolled(`second-factor-paths-${tag}@example.test`),
    (jar: Jar) => send(jar, "POST", "/api/auth/two-factor/get-totp-uri", { password: PASSWORD }),
  ],
  [
    "member route",
    async (tag: string) => {
      const enrolled = await fx.enrolled(`second-factor-members-${tag}@example.test`);
      const id = await userIdOf(fx, enrolled.email);
      await addWorkspaceMember(fx, workspace, id, "admin");
      return enrolled;
    },
    (jar: Jar) =>
      send(jar, "PATCH", `/api/v1/workspaces/${workspace}/members/${viewerId}`, { role_key: "editor" }),
  ],
  [
    "admin route",
    async () => instanceAdmin,
    (jar: Jar) => send(jar, "PUT", `/api/v1/admin/flags/${FLAG}/override`, { on: true }),
  ],
] as const;

describe("a step_up route for an account with the second factor on (security floor)", () => {
  it.each(ROWS)(
    "%s: a password step-up gets 403 with method totp; a totp step-up passes and no log line holds the code",
    async (_family, enroll, act) => {
      const enrolled = await enroll("1");
      const { jar } = enrolled;
      // The enrolment's code made a totp step-up; a password check afterwards is the newest record.
      expect((await send(jar, "POST", "/api/auth/verify-password", { password: PASSWORD })).status).toBe(200);
      const refused = await act(jar);
      expect([refused.status, await refusalOf(refused)]).toEqual([
        403,
        { code: "step_up_required", details: { method: "totp" } },
      ]);
      const code = totpAt(enrolled.secret, 1);
      expect((await send(jar, "POST", "/api/auth/two-factor/verify-totp", { code })).status).toBe(200);
      expect((await act(jar)).status).toBe(200);
      expect(fx.logged.filter((line) => new RegExp(`(?<!\\d)${code}(?!\\d)`).test(line))).toEqual([]);
    },
    30_000,
  );

  it("a wrong code on verify-totp with a live session answers 401 invalid_credentials", async () => {
    const { jar } = await fx.enrolled("second-factor-wrong-1@example.test");
    const wrong = await send(jar, "POST", "/api/auth/two-factor/verify-totp", { code: "000000" });
    expect([wrong.status, (await refusalOf(wrong)).code]).toEqual([401, "invalid_credentials"]);
  }, 30_000);
});

// R512 and R545: a backup code with a live session proves identity again as a totp code does; the record, the audit
// row and the throttle follow the same path. A person who lost the device can still reach the same routes.
const BACKUP = "/api/auth/two-factor/verify-backup-code";
const recordedMethods = (email: string) =>
  fx.admin(async (client) => {
    const found = await client.query(
      `SELECT s.method FROM app.session_step_ups s JOIN auth."user" u ON u.id = s.user_id
       WHERE u.email = $1 ORDER BY s.at, s.method`,
      [email],
    );
    return found.rows.map((row) => row.method as string);
  });
const auditedMethods = (email: string) =>
  fx.admin(async (client) => {
    const found = await client.query(
      `SELECT l.action || '/' || (l.metadata->>'method') AS shape
       FROM app.audit_logs l JOIN auth."user" u ON u.id::text = l.actor_ref
       WHERE u.email = $1 ORDER BY l.at, l.id`,
      [email],
    );
    return found.rows.map((row) => row.shape as string);
  });

describe("a backup code step-up (security floor)", () => {
  it.each(ROWS)(
    "%s: a backup code opens it after a password check, writes auth.step_up/backup_code, and the same code twice is refused",
    async (_family, enroll, act) => {
      const enrolled = await enroll("2");
      const { jar } = enrolled;
      expect((await send(jar, "POST", "/api/auth/verify-password", { password: PASSWORD })).status).toBe(200);
      expect((await act(jar)).status).toBe(403);
      const code = enrolled.backupCodes[0];
      expect((await send(jar, "POST", BACKUP, { code })).status).toBe(200);
      expect((await act(jar)).status).toBe(200);
      expect(await auditedMethods(enrolled.email)).toContain("auth.step_up/backup_code");
      expect(await recordedMethods(enrolled.email)).toContain("backup_code");
      const again = await send(jar, "POST", BACKUP, { code });
      expect([again.status, (await refusalOf(again)).code]).toEqual([401, "invalid_credentials"]);
      expect(fx.logged.filter((line) => line.includes(String(code)))).toEqual([]);
    },
    30_000,
  );
});

describe("a backup code that is refused, and one that finishes a sign-in (security floor)", () => {
  it.each([
    ["a wrong code", 401, async () => undefined],
    [
      "a code past the two_factor limit",
      429,
      async (email: string) => {
        const id = await userIdOf(fx, email);
        await fx.admin((client) =>
          client.query(
            `INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('two_factor', $1, 0)
             ON CONFLICT (scope, key) DO UPDATE SET tokens = 0, refilled_at = clock_timestamp()`,
            [fx.auth.bucketKey("two_factor", id)],
          ),
        );
      },
    ],
  ])(
    "%s with a live session records no step-up and writes no audit row",
    async (name, status, prepare) => {
      const email = `backup-refused-${name.includes("wrong") ? "wrong" : "limit"}-1@example.test`;
      const enrolled = await fx.enrolled(email);
      await prepare(email);
      const sent = name.includes("wrong") ? "wrong-code" : enrolled.backupCodes[0];
      const refused = await send(enrolled.jar, "POST", BACKUP, { code: sent });
      expect(refused.status).toBe(status);
      expect(await recordedMethods(email)).not.toContain("backup_code");
      expect(await auditedMethods(email)).not.toContain("auth.step_up/backup_code");
      // The control that keeps the two assertions above honest: once the bucket is empty of the test's doing, the
      // real code records exactly one step-up and one audit row, so the path can record at all.
      await fx.admin(async (client) =>
        client.query("DELETE FROM app.rate_buckets WHERE scope = 'two_factor' AND key = $1", [
          fx.auth.bucketKey("two_factor", await userIdOf(fx, email)),
        ]),
      );
      const real = await send(enrolled.jar, "POST", BACKUP, { code: enrolled.backupCodes[0] });
      expect(real.status).toBe(200);
      expect((await recordedMethods(email)).filter((method) => method === "backup_code")).toHaveLength(1);
      const audited = await auditedMethods(email);
      expect(audited.filter((shape) => shape === "auth.step_up/backup_code")).toHaveLength(1);
    },
    30_000,
  );

  it("a sign-in finished with a backup code records a backup_code step-up", async () => {
    const email = "backup-sign-in-1@example.test";
    const enrolled = await fx.enrolled(email);
    const { jar } = await fx.challenged(email);
    expect((await send(jar, "POST", BACKUP, { code: enrolled.backupCodes[0] })).status).toBe(200);
    expect(await recordedMethods(email)).toContain("backup_code");
  }, 30_000);
});
