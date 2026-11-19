import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorResponse, isUnavailable, Refusal, toRefusal } from "./refusal.js";

describe("the answer of a link that cannot be used", () => {
  it("is a 400 with its own code and a fixed message that echoes no input", async () => {
    const app = new Hono();
    app.onError((error, c) => errorResponse(c as never, toRefusal(error)));
    app.get("/link", () => {
      throw new Refusal("link_unusable", "token abc123 was rejected");
    });
    const answer = await app.request("/link");
    const body = (await answer.json()) as { error: { code: string; message: string } };
    expect([answer.status, body.error.code]).toEqual([400, "link_unusable"]);
    expect(body.error.message).toBe("The link can no longer be used.");
  });
});

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const wrapped = (inner: Error, depth: number): Error =>
  depth === 0 ? inner : wrapped(new Error("Failed query", { cause: inner }), depth - 1);

describe("a database outage behind wrapper errors", () => {
  it.each([
    ["one wrapper (the query builder's error)", wrapped(refused(), 1), true],
    ["five wrappers", wrapped(refused(), 5), true],
    ["six wrappers, past the bound", wrapped(refused(), 6), false],
    ["a wrapper around a plain failure", wrapped(new Error("syntax error"), 1), false],
  ])("%s is classified from its cause chain", (_name, error, unavailable) => {
    expect(isUnavailable(error)).toBe(unavailable);
    expect(toRefusal(error).code).toBe(unavailable ? "service_unavailable" : "internal_error");
  });
});
