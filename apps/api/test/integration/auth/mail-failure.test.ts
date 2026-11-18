import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, PASSWORD, startFixture } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

// What a client can compare: the status, the body without its request id, and the headers without the per-request ones.
async function shape(answer: Response) {
  const body = (await answer.json()) as { error: Record<string, unknown> };
  if (body.error) body.error.requestId = "x";
  const headers = [...answer.headers.entries()].filter(([name]) => !["x-request-id", "date"].includes(name));
  return { status: answer.status, body, headers };
}

describe("a mail queue that fails at sign-up", () => {
  it("a failing mail enqueue at sign-up answers 503 for a new and an existing email alike and logs no secret", async () => {
    const existing = "enqueue-existing-1@example.test";
    const fresh = "enqueue-new-1@example.test";
    await fx.request("/api/auth/sign-up/email", { body: { name: "T", email: existing, password: PASSWORD } });
    // The queue's table refuses every insert as an outage would (SQLSTATE 57P03).
    await fx.admin(async (client) => {
      await client.query(
        `CREATE FUNCTION public.outbox_down() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'the outbox is down' USING ERRCODE = '57P03'; END $$`,
      );
      await client.query(
        `CREATE TRIGGER outbox_down BEFORE INSERT ON app.email_outbox
         FOR EACH ROW EXECUTE FUNCTION public.outbox_down()`,
      );
    });
    const send = (email: string) =>
      fx.request("/api/auth/sign-up/email", { body: { name: "T", email, password: PASSWORD } });
    const answerNew = await shape(await send(fresh));
    const answerExisting = await shape(await send(existing));
    expect(answerNew.status).toBe(503);
    expect(answerNew.body.error.code).toBe("service_unavailable");
    expect(answerExisting).toEqual(answerNew);
    const logs = fx.logged.join("");
    for (const secret of [existing, fresh, "token="]) expect(logs).not.toContain(secret);
  });
});
