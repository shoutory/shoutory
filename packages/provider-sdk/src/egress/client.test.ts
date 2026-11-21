import { describe, expect, it } from "vitest";
import { nextHop } from "./client.js";
import { EgressError } from "./errors.js";

const CALLER_HEADERS = {
  accept: "application/json",
  "accept-language": "ar",
  "user-agent": "shoutory-test",
  authorization: "Bearer hop-token-1",
  cookie: "sid=hop-cookie-1",
  "proxy-authorization": "Basic hop-proxy-1",
  "x-api-key": "hop-key-1",
  host: "origin.test",
  "content-type": "application/json",
  "content-length": "7",
  "transfer-encoding": "chunked",
};
const SAFE = ["accept", "accept-language", "user-agent"];

const hop = (method: string, body?: string) => ({
  url: new URL("http://origin.test:8080/start"),
  method,
  headers: CALLER_HEADERS,
  body,
});
const redirect = (status: number, location: string) => ({
  status,
  headers: { location },
  body: new Uint8Array(),
});
const namesOf = (next: ReturnType<typeof nextHop>) => Object.keys(next?.headers ?? {}).sort();

describe("the headers a redirect hop carries (SSRF-11)", () => {
  it.each([
    ["another host", "http://other.test:8080/x"],
    ["another port", "http://origin.test:9090/x"],
    ["another scheme", "https://origin.test:8080/x"],
  ])("a hop to %s sends only the safe headers, with no x-api-key and no body headers", (_name, location) => {
    expect(namesOf(nextHop(hop("GET"), redirect(302, location)))).toEqual([...SAFE].sort());
  });

  it("a same-origin hop keeps the caller's headers except host", () => {
    const next = nextHop(hop("GET"), redirect(302, "/next"));
    expect(next?.headers.authorization).toBe("Bearer hop-token-1");
    expect(next?.headers["x-api-key"]).toBe("hop-key-1");
    expect(next?.headers).not.toHaveProperty("host");
  });

  it("a hop that drops the body drops its content and transfer headers too", () => {
    const next = nextHop(hop("POST", "payload"), redirect(302, "/next"));
    expect(next).toMatchObject({ method: "GET", body: undefined });
    for (const name of ["content-type", "content-length", "transfer-encoding"]) {
      expect(next?.headers).not.toHaveProperty(name);
    }
  });

  it.each([307, 308])("a cross-origin %i that would carry a body is refused, never forwarded", (status) => {
    expect(() => nextHop(hop("POST", "payload"), redirect(status, "http://other.test:8080/x"))).toThrow(
      EgressError,
    );
  });

  it("a same-origin 307 keeps the method and the body", () => {
    expect(nextHop(hop("POST", "payload"), redirect(307, "/next"))).toMatchObject({
      method: "POST",
      body: "payload",
    });
  });
});
