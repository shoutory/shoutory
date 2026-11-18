import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, Jar, PASSWORD, startFixture, totpAt } from "./harness.js";

// The floor of the sign-in and step-up audit rows (NFR-SEC-18): when the instance-chain writer fails, the call
// answers 503 and nothing that proves identity is granted.

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const WRITER = "app.audit_insert_instance(text, text, text, text, bytea, jsonb)";
const revokeWriter = () =>
  fx.admin((client) => client.query(`REVOKE EXECUTE ON FUNCTION ${WRITER} FROM shoutory_auth`));
// The per-file clone is shared by the rows: the next row starts with the writer in place.
afterEach(() => fx.admin((client) => client.query(`GRANT EXECUTE ON FUNCTION ${WRITER} TO shoutory_auth`)));

// A success has no `error`: the row then fails on the comparison, not on reading the body.
const codeOf = async (answer: Response) =>
  ((await answer.json()) as { error?: { code: string } }).error?.code ?? "no_error";
const stepUpRows = (email: string) =>
  fx.admin(async (client) =>
    Number(
      (
        await client.query(
          `SELECT count(*) FROM app.session_step_ups s JOIN auth."user" u ON u.id = s.user_id
             WHERE u.email = $1`,
          [email],
        )
      ).rows[0].count,
    ),
  );
const ageStepUps = (email: string) =>
  fx.admin((client) =>
    client.query(
      `UPDATE app.session_step_ups SET at = clock_timestamp() - interval '11 minutes'
       WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [email],
    ),
  );

/** A row prepares its user while the writer works and returns the one call that must meet the failing writer. */
type Prepared = { call: () => Promise<Response>; jar?: Jar };
const WRITERS: ReadonlyArray<[string, "sign_in" | "step_up", (email: string) => Promise<Prepared>]> = [
  [
    "password sign-in",
    "sign_in",
    async (email) => {
      await fx.signedIn(email);
      return { call: () => fx.request("/api/auth/sign-in/email", { body: { email, password: PASSWORD } }) };
    },
  ],
  [
    "second-factor sign-in (secondFactorCode)",
    "sign_in",
    async (email) => {
      const enrolled = await fx.enrolled(email);
      const { jar } = await fx.challenged(email);
      return {
        call: () =>
          fx.request("/api/auth/two-factor/verify-totp", {
            body: { code: totpAt(enrolled.secret, 1) },
            headers: jar.header,
          }),
      };
    },
  ],
  [
    "backup-code sign-in (secondFactorCode)",
    "sign_in",
    async (email) => {
      const enrolled = await fx.enrolled(email);
      const { jar } = await fx.challenged(email);
      return {
        call: () =>
          fx.request("/api/auth/two-factor/verify-backup-code", {
            body: { code: enrolled.backupCodes[0] },
            headers: jar.header,
          }),
      };
    },
  ],
  [
    "password step-up (verify-password)",
    "step_up",
    async (email) => {
      const jar = new Jar(await fx.signedIn(email));
      await ageStepUps(email);
      return {
        jar,
        call: () =>
          fx.request("/api/auth/verify-password", { body: { password: PASSWORD }, headers: jar.header }),
      };
    },
  ],
  [
    "TOTP step-up (verify-totp on a live session)",
    "step_up",
    async (email) => {
      const enrolled = await fx.enrolled(email);
      await ageStepUps(email);
      return {
        jar: enrolled.jar,
        call: () =>
          fx.request("/api/auth/two-factor/verify-totp", {
            body: { code: totpAt(enrolled.secret, 1) },
            headers: enrolled.jar.header,
          }),
      };
    },
  ],
];

describe("a failed audit write after a correct credential", () => {
  it.each(WRITERS.map((row, index) => [index, ...row] as const))(
    "[%i] %s answers 503 service_unavailable, sets no cookie and grants nothing",
    async (index, _label, kind, prepare) => {
      const email = `audit-fail-${index}@example.test`;
      const { call, jar } = await prepare(email);
      const sessionsBefore = await fx.sessionCount(email);
      const stepUpsBefore = await stepUpRows(email);
      await revokeWriter();

      const answer = await call();

      expect([answer.status, await codeOf(answer)]).toEqual([503, "service_unavailable"]);
      expect(answer.headers.getSetCookie()).toEqual([]);
      if (kind === "sign_in") {
        // The session row stays (the accepted atomicity of the plan): only the cookie never leaves.
        expect(await fx.sessionCount(email)).toBe(sessionsBefore + 1);
        return;
      }
      expect(await stepUpRows(email)).toBe(stepUpsBefore);
      // A danger action still asks for the step-up the failed call would have recorded.
      const danger = await fx.request("/api/auth/two-factor/enable", {
        body: { password: PASSWORD },
        headers: (jar ?? new Jar()).header,
      });
      expect([danger.status, await codeOf(danger)]).toEqual([403, "step_up_required"]);
    },
    30_000,
  );
});
