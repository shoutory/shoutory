import { describe, expect, it } from "vitest";
import type { EgressRequest, EgressResponse } from "./client.js";
import { EgressError, type EgressErrorClass } from "./errors.js";
import { fetchOf } from "./fetch-adapter.js";

const body = (text: string) => new TextEncoder().encode(text);

describe("fetchOf", () => {
  it("passes the request to the egress call and answers a Response from its status, headers and body", async () => {
    // fails first because: there is no function that turns the bound egress call into the `fetch` an adapter is given
    const seen: EgressRequest[] = [];
    const answer: EgressResponse = {
      status: 201,
      headers: { "content-type": "application/json", "retry-after": "5", "x-many": ["a", "b"] },
      body: body('{"id":"p1"}'),
    };
    const signal = new AbortController().signal;
    const send = fetchOf(async (request) => {
      seen.push(request);
      return answer;
    });
    const reply = await send("https://api.fixture.example/v1/posts", {
      method: "POST",
      headers: { "idempotency-key": "k-1" },
      body: '{"text":"hi"}',
      signal,
    });
    expect([reply.status, reply.ok, reply.headers.get("retry-after"), reply.headers.get("x-many")]).toEqual([
      201,
      true,
      "5",
      "a, b",
    ]);
    expect(await reply.json()).toEqual({ id: "p1" });
    expect(seen[0]).toMatchObject({
      url: "https://api.fixture.example/v1/posts",
      method: "POST",
      headers: { "idempotency-key": "k-1" },
      body: '{"text":"hi"}',
      signal,
    });
  });

  it.each([204, 304])("answers a %i with no body as a Response without one", async (status) => {
    // fails first because: a Response built with a body for a status that has none throws
    const send = fetchOf(async () => ({ status, headers: {}, body: new Uint8Array() }));
    expect((await send("https://api.fixture.example/v1/x")).status).toBe(status);
  });
});

describe("fetchOf failures", () => {
  // [the egress failure, the error an adapter classifies]: nothing of the original travels on
  const FAILURES: [EgressErrorClass, "none" | "possible", { name?: string; code?: string }][] = [
    ["connect", "none", { code: "ECONNREFUSED" }],
    ["blocked_address", "none", { code: "ECONNREFUSED" }],
    ["timeout", "possible", { name: "TimeoutError" }],
    ["network", "possible", { code: "ECONNRESET" }],
  ];
  it.each(FAILURES)(
    "rethrows an egress %s (effect %s) as an error the adapter classifies",
    async (klass, effect, shape) => {
      // fails first because: an EgressError reaches the adapter as it is, which it cannot tell from a bug and rethrows
      const send = fetchOf(async () => {
        throw new EgressError({ class: klass, host: "api.fixture.example", effect });
      });
      const error = await send("https://api.fixture.example/v1/posts", { method: "POST" }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EgressError);
      if (shape.name !== undefined) expect((error as Error).name).toBe(shape.name);
      if (shape.code !== undefined)
        expect(((error as Error).cause as { code?: string }).code).toBe(shape.code);
      expect((error as Error).message).not.toContain("api.fixture.example");
    },
  );
});
