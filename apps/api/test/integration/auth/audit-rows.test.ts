import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, Jar, PASSWORD, PEPPER, startFixture, totpAt } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const rowsOf = (email: string) =>
  fx.admin(async (client) => {
    const found = await client.query(
      `SELECT l.action, l.actor_kind, l.metadata, l.request_id, l.ip_hmac, l.workspace_id
       FROM app.audit_logs l JOIN auth."user" u ON u.id::text = l.actor_ref
       WHERE u.email = $1 ORDER BY l.at, l.id`,
      [email],
    );
    return found.rows;
  });
const shape = (rows: Array<{ action: string; metadata: { method: string } }>) =>
  rows.map((row) => `${row.action}/${row.metadata.method}`);

describe("sign-in and step-up audit rows", () => {
  it("sign-in and step-up write instance-chain rows with the request id and the keyed ip digest", async () => {
    const email = "audit-rows-1@example.test";
    const peer = "192.0.2.201";
    const jar = new Jar(await fx.signedIn(email, peer));
    const stepUp = await fx.request("/api/auth/verify-password", {
      body: { password: PASSWORD },
      headers: jar.header,
      peer,
    });
    const rows = await rowsOf(email);
    expect(shape(rows)).toEqual(["auth.sign_in/password", "auth.step_up/password"]);
    const digest = createHmac("sha256", Buffer.from(PEPPER)).update(`audit_ip:${peer}`).digest();
    for (const row of rows) {
      expect([row.actor_kind, row.workspace_id]).toEqual(["user", null]);
      expect(Buffer.from(row.ip_hmac).equals(digest)).toBe(true);
    }
    expect(rows[1]?.request_id).toBe(stepUp.headers.get("x-request-id"));
    expect(rows[0]?.request_id).toEqual(expect.any(String));
  });

  it("a TOTP enrolment, a second-factor sign-in and a backup-code sign-in write their own rows", async () => {
    const email = "audit-rows-2@example.test";
    const enrolled = await fx.enrolled(email);
    const code = totpAt(enrolled.secret, 1);
    const challenge = await fx.challenged(email);
    await fx.request("/api/auth/two-factor/verify-totp", { body: { code }, headers: challenge.jar.header });
    const second = await fx.challenged(email);
    await fx.request("/api/auth/two-factor/verify-backup-code", {
      body: { code: enrolled.backupCodes[0] },
      headers: second.jar.header,
    });
    expect(shape(await rowsOf(email))).toEqual([
      "auth.sign_in/password",
      "auth.step_up/totp",
      "auth.sign_in/totp",
      "auth.sign_in/backup_code",
    ]);
  });

  it("a TOTP code from a live session that still holds a leftover challenge cookie is a step-up, not a sign-in", async () => {
    const email = "audit-rows-3@example.test";
    const enrolled = await fx.enrolled(email);
    const leftover = await fx.challenged(email);
    const both = new Jar(`${enrolled.jar.header.cookie}; ${leftover.jar.header.cookie}`);
    const answer = await fx.request("/api/auth/two-factor/verify-totp", {
      body: { code: totpAt(enrolled.secret, 1) },
      headers: both.header,
    });
    expect(answer.status).toBe(200);
    expect(shape(await rowsOf(email))).toEqual([
      "auth.sign_in/password",
      "auth.step_up/totp",
      "auth.step_up/totp",
    ]);
  });
});
