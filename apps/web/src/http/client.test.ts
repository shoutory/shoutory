import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, request } from "./client";

const answer = z.object({ open: z.boolean() });

function stubFetch(response: Response) {
  const fetchStub = vi.fn((_path: string, _init?: RequestInit) => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("the api client", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("a %s call sends X-Shoutory-Client: web", async (method) => {
    const fetchStub = stubFetch(json({ data: { open: true } }));
    await request(answer, "/api/v1/instance/signup", { method, body: {} });
    const init = fetchStub.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("X-Shoutory-Client")).toBe("web");
  });

  it.each([
    ["a field of the wrong type", { data: { open: "yes" } }],
    ["a missing data envelope", { open: true }],
    ["an unknown shape", { data: [] }],
  ])("refuses a malformed 200 answer: %s", async (_name, body) => {
    stubFetch(json(body));
    await expect(request(answer, "/api/v1/instance/signup")).rejects.toBeInstanceOf(ApiError);
  });

  it.each([
    ["unauthenticated", 401, "session_expired"],
    ["forbidden", 403, "forbidden"],
    ["not_found", 404, "not_found"],
    ["service_unavailable", 503, "maintenance"],
    ["internal_error", 500, "error"],
    ["validation_failed", 400, "error"],
  ])("the code %s (HTTP %i) leads to the state %s", async (code, status, state) => {
    stubFetch(json({ error: { code, message: "m", requestId: "r1" } }, status));
    await expect(request(answer, "/api/v1/x")).rejects.toMatchObject({ state, code, requestId: "r1" });
  });

  it.each([
    ["unauthenticated", json({ error: { code: "unauthenticated", message: "m" } }, 401), "session_expired"],
    ["invalid_credentials", json({ error: { code: "invalid_credentials", message: "m" } }, 401), "error"],
    [
      "a body that is not our envelope",
      new Response("<html>gateway</html>", { status: 401 }),
      "session_expired",
    ],
  ])("a 401 with %s leads to the state %s", async (_name, response, state) => {
    stubFetch(response);
    await expect(request(answer, "/api/v1/x")).rejects.toMatchObject({ state });
  });

  it("a refused connection means maintenance", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(request(answer, "/api/v1/x")).rejects.toMatchObject({
      state: "maintenance",
      code: "network",
    });
  });
});

describe("the details of a refusal", () => {
  it.each([
    ["the reason the server gives", { reason: "expired", expires_at: "2026-11-20T10:00:00.000Z" }],
    ["nothing when the answer has none", undefined],
    ["nothing when it is not a map of text", ["expired"]],
  ])("an error carries %s as details", async (_name, sent) => {
    const error = { code: "invitation_unusable", message: "m", ...(sent ? { details: sent } : {}) };
    stubFetch(json({ error }, 410));
    const failure = await request(answer, "/api/v1/x").catch((caught: unknown) => caught);
    const expected = sent && !Array.isArray(sent) ? sent : undefined;
    expect((failure as { details?: unknown }).details).toEqual(expected);
  });
});

describe("the api client while it reads the body", () => {
  it.each([
    ["a dropped stream", () => new TypeError("terminated")],
    ["a timeout", () => new DOMException("The operation timed out", "TimeoutError")],
  ])("%s while the body is read means maintenance", async (_name, failure) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        controller.error(failure());
      },
    });
    stubFetch(new Response(body, { status: 200 }));
    await expect(request(answer, "/api/v1/x")).rejects.toMatchObject({
      name: "ApiError",
      state: "maintenance",
      code: "network",
    });
  });

  it("a body that stalls until the request's own timeout fires means maintenance", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal("fetch", (_path: string, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
            },
          }),
        ),
      ),
    );
    const pending = request(answer, "/api/v1/x");
    timeout.abort(new DOMException("The operation timed out", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ state: "maintenance", code: "network" });
  });

  it("an error body with an unknown code is not trusted", async () => {
    stubFetch(json({ error: { code: "made_up", message: "m" } }, 500));
    await expect(request(answer, "/api/v1/x")).rejects.toMatchObject({
      code: "invalid_response",
      state: "error",
    });
  });
});

const bare = z.union([
  z.object({ user: z.object({ id: z.string() }) }),
  z.object({ twoFactorRedirect: z.literal(true) }),
]);
const bareCall = () =>
  request(bare, "/api/auth/sign-in/email", { method: "POST", body: {}, envelope: false });

describe("a call without an answer envelope", () => {
  it.each([
    ["a user", { user: { id: "u1" } }],
    ["a challenge", { twoFactorRedirect: true }],
  ])("returns the bare body: %s", async (_name, body) => {
    const fetchStub = stubFetch(json(body));
    await expect(bareCall()).resolves.toEqual(body);
    expect(new Headers(fetchStub.mock.calls[0]?.[1]?.headers).get("X-Shoutory-Client")).toBe("web");
  });

  it.each([
    ["a body of the wrong shape", json({ nope: true })],
    ["an empty body", new Response(null, { status: 200 })],
    ["a body that is not JSON", new Response("ok", { status: 200 })],
  ])("refuses %s", async (_name, response) => {
    stubFetch(response);
    await expect(bareCall()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    ["a 401", json({ error: { code: "unauthenticated", message: "m" } }, 401), "session_expired"],
    ["a 503", json({ error: { code: "service_unavailable", message: "m" } }, 503), "maintenance"],
    ["a 500 with no envelope", new Response("boom", { status: 500 }), "error"],
  ])("still maps %s to the state %s", async (_name, response, state) => {
    stubFetch(response);
    await expect(bareCall()).rejects.toMatchObject({ state });
  });
});
