import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, PASSWORD, startFixture } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

interface Listed {
  id: string;
  current: boolean;
}
const list = async (cookie: string): Promise<Listed[]> => {
  const answer = await fx.request("/api/auth/sessions", { headers: { cookie } });
  return ((await answer.json()) as { data: Listed[] }).data;
};
const secondSession = async (email: string): Promise<string> => {
  const answer = await fx.request("/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
  return answer.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .join("; ");
};

describe("session list and revoke", () => {
  it("revoking a session by id ends it: its next request answers 401, and the other session stays", async () => {
    const email = "revoke-1@example.test";
    const first = await fx.signedIn(email);
    const second = await secondSession(email);
    const target = (await list(first)).find((item) => !item.current);
    expect(target).toBeDefined();
    const revoked = await fx.request("/api/auth/sessions/revoke", {
      body: { id: target?.id },
      headers: { cookie: first },
    });
    expect(revoked.status).toBe(200);
    expect((await fx.request("/api/auth/sessions", { headers: { cookie: second } })).status).toBe(401);
    expect((await fx.request("/api/auth/sessions", { headers: { cookie: first } })).status).toBe(200);
  });

  it("revoke-others keeps the current session and ends the rest; an expired session answers 401", async () => {
    const email = "revoke-2@example.test";
    const first = await fx.signedIn(email);
    const second = await secondSession(email);
    await fx.request("/api/auth/sessions/revoke-others", { body: {}, headers: { cookie: second } });
    expect((await fx.request("/api/auth/sessions", { headers: { cookie: first } })).status).toBe(401);
    expect((await list(second)).length).toBe(1);
    await fx.admin((client) =>
      client.query("UPDATE auth.session SET expires_at = now() - interval '1 minute'"),
    );
    expect((await fx.request("/api/auth/sessions", { headers: { cookie: second } })).status).toBe(401);
  });

  it("a session id of another user revokes nothing", async () => {
    const mine = await fx.signedIn("revoke-3@example.test");
    const theirs = await fx.signedIn("revoke-4@example.test");
    const victim = (await list(theirs))[0];
    await fx.request("/api/auth/sessions/revoke", { body: { id: victim?.id }, headers: { cookie: mine } });
    expect((await fx.request("/api/auth/sessions", { headers: { cookie: theirs } })).status).toBe(200);
  });
});
