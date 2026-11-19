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
  // The server refuses an unsafe call without the header (security/csrf.ts), so every one must carry it.
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

  // The state each failure leads to: the guard and the screens read `state`, never the code or the status.
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

  it("a 401 whose body is not our envelope still means the session expired", async () => {
    stubFetch(new Response("<html>gateway</html>", { status: 401 }));
    await expect(request(answer, "/api/v1/x")).rejects.toMatchObject({ state: "session_expired" });
  });

  it("a refused connection means maintenance", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(request(answer, "/api/v1/x")).rejects.toMatchObject({
      state: "maintenance",
      code: "network",
    });
  });
});

describe("the api client while it reads the body", () => {
  // R387: the 15 s limit also covers reading the body; a timeout or a dropped stream there is a network failure too.
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
