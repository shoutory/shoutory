import { createHash } from "node:crypto";
import { SealedSecret } from "@shoutory/core/crypto";
import { pepperDigest } from "@shoutory/core/crypto/digest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipSubject } from "../../src/auth/throttle.js";
import {
  addWorkspaceMember,
  seedOrganization,
  seedWorkspace,
  signedUser,
  unique,
} from "../support/tenancy.js";
import { type Fixture, PEPPER, startFixture } from "./auth/harness.js";

type User = { id: string; cookie: string };
let fx: Fixture;
let ws: string;
let admin: User;
let owner: User;

const base = (id: string) => `/api/v1/workspaces/${id}`;
const ACCEPT = "/api/v1/invitations/accept";
const MISSING = "019a0000-0000-7000-8000-000000000000";
const tokenText = (fill: number) => Buffer.alloc(32, fill).toString("base64url");

beforeAll(async () => {
  fx = await startFixture();
  const orgOwner = await signedUser(fx, "inv-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, orgOwner.id));
  owner = await signedUser(fx, "inv-owner");
  admin = await signedUser(fx, "inv-admin");
  await addWorkspaceMember(fx, ws, owner.id, "owner");
  await addWorkspaceMember(fx, ws, admin.id, "admin");
});
afterAll(() => fx.close());

const newEmail = () => `${unique("invitee")}@example.test`;
const send = (who: User, method: string, path: string, body?: Record<string, unknown>, peer?: string) =>
  fx.request(path, {
    method,
    headers: { cookie: who.cookie },
    ...(body ? { body } : {}),
    ...(peer ? { peer } : {}),
  });
const invite = (who: User, email: string, workspace = ws, peer?: string) =>
  send(who, "POST", `${base(workspace)}/invitations`, { email, role_key: "editor" }, peer);
const errorOf = async (answer: Response) => {
  const { error } = (await answer.json()) as { error: { code: string; details?: Record<string, string> } };
  return { status: answer.status, code: error.code, details: error.details };
};
const reasonOf = async (answer: Response) => {
  const { status, code, details } = await errorOf(answer);
  return [status, code, details?.reason];
};
const tokenOf = async (email: string) => {
  const [mail] = await fx.mails(email);
  return String(mail?.link).split("/invite/")[1] ?? "";
};
const rowOf = (email: string) =>
  fx.admin(
    async (client) => (await client.query("SELECT * FROM app.invitations WHERE email = $1", [email])).rows[0],
  );
const revoke = async (email: string) =>
  send(admin, "DELETE", `${base(ws)}/invitations/${(await rowOf(email)).id}`);

async function invited() {
  const email = newEmail();
  const cookie = await fx.signedIn(email);
  expect((await invite(admin, email)).status).toBe(201);
  return { email, who: { id: "", cookie }, token: await tokenOf(email) };
}

describe("the token", () => {
  it("is stored as its SHA-256, is never listed and appears in no log in any form", async () => {
    const email = newEmail();
    expect((await invite(admin, email)).status).toBe(201);
    const token = await tokenOf(email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = createHash("sha256").update(Buffer.from(token, "base64url")).digest();
    expect((await rowOf(email)).token_hash).toEqual(digest);
    const listed = await (await send(admin, "GET", `${base(ws)}/invitations`)).text();
    expect(listed).toContain(email);
    expect(listed).not.toContain("token_hash");
    const forms = [
      token,
      Buffer.from(token).toString("hex"),
      Buffer.from(token).toString("base64"),
      Buffer.from(token, "base64url").toString("hex"),
      encodeURIComponent(token),
    ];
    for (const form of forms) expect(fx.logged.join("\n")).not.toContain(form);
  });

  it("a GET and a HEAD on /invite/{token} leave the invitation pending", async () => {
    const email = newEmail();
    await invite(admin, email);
    const token = await tokenOf(email);
    for (const method of ["GET", "HEAD"]) await fx.request(`/invite/${token}`, { method });
    const after = await rowOf(email);
    expect([after.accepted_at, after.revoked_at]).toEqual([null, null]);
  });

  it.each([
    ["the token in the query string", `${ACCEPT}?token=abc`, { token: "abc" }],
    ["a role_key in the body", ACCEPT, { token: "abc", role_key: "admin" }],
  ])("accept refuses %s with 400", async (_label, path, body) => {
    expect((await send(admin, "POST", path, body)).status).toBe(400);
  });
});

describe("accept answers", () => {
  it("another account gets email_mismatch whatever the state of the invitation", async () => {
    const { email, token } = await invited();
    const stranger = await signedUser(fx, "inv-stranger");
    const pending = await errorOf(await send(stranger, "POST", ACCEPT, { token }));
    await revoke(email);
    const revoked = await errorOf(await send(stranger, "POST", ACCEPT, { token }));
    const expected = { status: 403, code: "forbidden", details: { reason: "email_mismatch" } };
    expect([pending, revoked]).toEqual([expected, expected]);
  });

  const END: Record<string, (i: Awaited<ReturnType<typeof invited>>) => Promise<unknown>> = {
    used: (i) => send(i.who, "POST", ACCEPT, { token: i.token }),
    revoked: (i) => revoke(i.email),
    expired: (i) =>
      fx.admin((client) =>
        client.query("UPDATE app.invitations SET expires_at = now() - interval '1 hour' WHERE email = $1", [
          i.email,
        ]),
      ),
  };

  it.each(["used", "revoked", "expired"])(
    "the invited account gets %s as 410 invitation_unusable with that reason",
    async (reason) => {
      const made = await invited();
      await END[reason]?.(made);
      const answer = await send(made.who, "POST", ACCEPT, { token: made.token });
      const body = await errorOf(answer.clone());
      expect(await reasonOf(answer)).toEqual([410, "invitation_unusable", reason]);
      expect(typeof body.details?.expires_at).toBe(reason === "expired" ? "string" : "undefined");
      expect(JSON.stringify(body)).not.toContain("invited by");
    },
  );
});

describe("the invitation list", () => {
  it("never holds an invitation of another workspace", async () => {
    const otherOwner = await signedUser(fx, "inv-list-owner");
    const otherWs = await seedWorkspace(fx, await seedOrganization(fx, otherOwner.id));
    await addWorkspaceMember(fx, otherWs, otherOwner.id, "owner");
    const [mine, theirs] = [newEmail(), newEmail()];
    expect((await invite(admin, mine)).status).toBe(201);
    expect((await invite(otherOwner, theirs, otherWs)).status).toBe(201);
    const listed = await (await send(admin, "GET", `${base(ws)}/invitations`)).text();
    expect([listed.includes(mine), listed.includes(theirs)]).toEqual([true, false]);
  });
});

describe("accept, an unverified address", () => {
  it("gives 403 email_unverified to the invited account and leaves the row pending", async () => {
    const { email, who, token } = await invited();
    await fx.admin((client) =>
      client.query('UPDATE auth."user" SET email_verified = false WHERE email = $1', [email]),
    );
    const answer = await send(who, "POST", ACCEPT, { token });
    expect(await errorOf(answer)).toEqual({
      status: 403,
      code: "forbidden",
      details: { reason: "email_unverified" },
    });
    const after = await rowOf(email);
    expect([after.accepted_at, after.revoked_at]).toEqual([null, null]);
  });
});

describe("accept, unknown rows and races", () => {
  it("a forged token and a planted owner-role row answer the identical 404", async () => {
    const email = newEmail();
    const who = { id: "", cookie: await fx.signedIn(email) };
    expect((await send(who, "POST", ACCEPT, {})).status).toBe(400);
    await fx.admin((client) =>
      client.query(
        `INSERT INTO app.invitations (workspace_id, email, role_id, token_hash, expires_at, invited_by)
         SELECT $1, $2, r.id, $3, now() + interval '1 day', $4
         FROM app.roles r WHERE r.workspace_id IS NULL AND r.key = 'owner'`,
        [
          ws,
          email,
          createHash("sha256")
            .update(Buffer.from(tokenText(5), "base64url"))
            .digest(),
          owner.id,
        ],
      ),
    );
    const planted = await errorOf(await send(who, "POST", ACCEPT, { token: tokenText(5) }));
    const forged = await errorOf(await send(who, "POST", ACCEPT, { token: tokenText(7) }));
    expect(planted.status).toBe(404);
    expect(planted).toEqual(forged);
  });

  it("two concurrent POSTs add exactly one member", async () => {
    const { email, who, token } = await invited();
    const answers = await Promise.all([1, 2].map(() => send(who, "POST", ACCEPT, { token })));
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 410]);
    const members = await fx.admin((client) =>
      client.query(
        'SELECT 1 FROM app.workspace_members m JOIN auth."user" u ON u.id = m.user_id WHERE u.email = $1',
        [email],
      ),
    );
    expect(members.rowCount).toBe(1);
  });
});

describe("invitation routes refuse a foreign or missing workspace alike", () => {
  it("create and revoke answer the identical 404", async () => {
    const foreign = await seedWorkspace(fx, await seedOrganization(fx, (await signedUser(fx, "inv-f")).id));
    expect((await invite(admin, newEmail(), "not-a-uuid")).status).toBe(400);
    const answer = async (id: string) => [
      await errorOf(await invite(admin, newEmail(), id)),
      await errorOf(await send(admin, "DELETE", `${base(id)}/invitations/${MISSING}`)),
    ];
    const [foreignAnswers, missingAnswers] = [await answer(foreign), await answer(MISSING)];
    expect(foreignAnswers.map((e) => e.status)).toEqual([404, 404]);
    expect(foreignAnswers).toEqual(missingAnswers);
  });
});

describe("throttles", () => {
  const empty = (scope: string, subject: string) =>
    fx.admin((client) =>
      client.query(
        `INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ($1, $2, 0)
         ON CONFLICT (scope, key) DO UPDATE SET tokens = 0, refilled_at = clock_timestamp()`,
        [scope, pepperDigest(new SealedSecret(PEPPER), scope, subject)],
      ),
    );

  it("the 21st create of an account in an hour is 429 with Retry-After", async () => {
    const thrower = await signedUser(fx, "inv-throw");
    await addWorkspaceMember(fx, ws, thrower.id, "admin");
    const answers: Response[] = [];
    for (let i = 0; i < 21; i++) answers.push(await invite(thrower, newEmail()));
    expect(answers.map((answer) => answer.status)).toEqual([...Array(20).fill(201), 429]);
    expect(Number(answers[20]?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("an emptied per-IP create bucket is 429 for another account at that address", async () => {
    const peer = "198.51.100.9";
    await empty("invite", ipSubject(peer));
    const answer = await invite(admin, newEmail(), ws, peer);
    expect([answer.status, answer.headers.has("retry-after")]).toEqual([429, true]);
  });

  it("the 11th accept of an account in 15 minutes is 429", async () => {
    const caller = await signedUser(fx, "inv-accept");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await send(caller, "POST", ACCEPT, { token: tokenText(i) })).status);
    }
    expect(statuses).toEqual([...Array(10).fill(404), 429]);
  });

  it("an emptied link_confirm bucket of the address is 429 on accept", async () => {
    const peer = "198.51.100.10";
    await empty("link_confirm", ipSubject(peer));
    const answer = await send(admin, "POST", ACCEPT, { token: tokenText(9) }, peer);
    expect([answer.status, answer.headers.has("retry-after")]).toEqual([429, true]);
  });
});
