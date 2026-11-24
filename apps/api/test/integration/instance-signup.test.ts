import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

const PATH = "/api/v1/instance/signup";
const CACHE_MS = 5_000;

describe("GET /api/v1/instance/signup", () => {
  let fx: Fixture;
  let clock = 1_000_000;
  beforeAll(async () => {
    fx = await startFixture({ signupOpen: false, now: () => clock });
    await signedUser(fx, "mode-founder");
  });
  afterAll(() => fx.close());

  it("answers only { open } to an anonymous caller", async () => {
    const anonymous = await fx.request(PATH);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ data: { open: false } });
  });

  const mode = async () =>
    ((await (await fx.request(PATH)).json()) as { data?: { open: boolean } }).data?.open;

  it("counts the cache as lapsed when the clock steps back", async () => {
    clock += CACHE_MS + 1;
    expect(await mode()).toBe(false);
    await fx.admin((client) =>
      client.query("INSERT INTO app.instance_settings (key, value) VALUES ('signup_enabled', 'true'::jsonb)"),
    );
    clock -= 1;
    expect(await mode()).toBe(true);
    await fx.admin((client) => client.query("DELETE FROM app.instance_settings"));
    clock += CACHE_MS + 1;
  });

  it("is served from a cache of at most 5 s: a change shows after it lapses, not before", async () => {
    clock += CACHE_MS + 1;
    expect(await mode()).toBe(false);
    await fx.admin((client) =>
      client.query("INSERT INTO app.instance_settings (key, value) VALUES ('signup_enabled', 'true'::jsonb)"),
    );
    clock += CACHE_MS - 1;
    expect(await mode()).toBe(false);
    clock += 2;
    expect(await mode()).toBe(true);
  });
});
