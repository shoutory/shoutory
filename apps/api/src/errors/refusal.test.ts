import { describe, expect, it } from "vitest";
import { isUnavailable, toRefusal } from "./refusal.js";

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
