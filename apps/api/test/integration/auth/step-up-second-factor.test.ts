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
    async () => fx.enrolled("second-factor-paths-1@example.test"),
    (jar: Jar) => send(jar, "POST", "/api/auth/two-factor/get-totp-uri", { password: PASSWORD }),
  ],
  [
    "member route",
    async () => {
      const enrolled = await fx.enrolled("second-factor-members-1@example.test");
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
      const enrolled = await enroll();
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
