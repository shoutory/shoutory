import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.js";
import { createLogger } from "../logging/logger.js";
import { defineRoute } from "../routes/define-route.js";

const ORIGIN = "https://app.example.test";
const testKeys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});

function build() {
  const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
  const pool = createAppPool("postgres://shoutory_app:app-test-secret-1@127.0.0.1:1/none", () => undefined);
  const app = createApp({ publicOrigin: ORIGIN, trustedProxies: [], pool, keys: testKeys, logger });
  let calls = 0;
  for (const method of ["post", "put", "patch", "delete"] as const) {
    defineRoute(app, {
      method,
      path: `/test/${method}`,
      policy: "public",
      body: z.strictObject({}),
      handler: () => {
        calls += 1;
        return { ok: true };
      },
    });
  }
  const send = (method: string, headers: Record<string, string>, body = "{}") =>
    Promise.resolve(
      app.request(
        `/test/${method.toLowerCase()}`,
        { method, headers: { "content-type": "application/json", ...headers }, body },
        { incoming: { socket: { remoteAddress: "192.0.2.1" } } },
      ),
    );
  return { send, calls: () => calls };
}

const CLIENT = { "x-shoutory-client": "web" };

describe("CSRF on unsafe methods", () => {
  it.each([
    ["same-origin fetch metadata with the client header", { "sec-fetch-site": "same-origin", ...CLIENT }],
    ["no fetch metadata, the exact public origin and the client header", { origin: ORIGIN, ...CLIENT }],
    ["a bearer credential, exempt from the browser checks", { authorization: "Bearer test-token-1" }],
  ])("passes %s", async (_name, headers) => {
    const { send, calls } = build();
    expect((await send("POST", headers)).status).toBe(200);
    expect(calls()).toBe(1);
  });

  it.each([
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site", origin: ORIGIN, ...CLIENT }],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site", origin: ORIGIN, ...CLIENT }],
    ["Sec-Fetch-Site none", { "sec-fetch-site": "none", origin: ORIGIN, ...CLIENT }],
    ["Origin null", { origin: "null", ...CLIENT }],
    ["both Sec-Fetch-Site and Origin missing", { ...CLIENT }],
    ["a look-alike origin (suffix)", { origin: `${ORIGIN}.evil.test`, ...CLIENT }],
    ["a look-alike origin (other scheme)", { origin: "http://app.example.test", ...CLIENT }],
    ["a look-alike origin (other port)", { origin: `${ORIGIN}:8443`, ...CLIENT }],
    ["same-origin fetch metadata without the client header", { "sec-fetch-site": "same-origin" }],
    ["the exact origin without the client header", { origin: ORIGIN }],
    ["a wrong client header value", { "sec-fetch-site": "same-origin", "x-shoutory-client": "mobile" }],
    ["an empty bearer scheme", { authorization: "Bearer" }],
  ])("refuses %s with 403 and the envelope before the handler", async (_name, headers) => {
    const { send, calls } = build();
    const response = await send("POST", headers);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("csrf_rejected");
    expect(calls()).toBe(0);
  });

  it("a bad CSRF header with an invalid body answers 403, not 400", async () => {
    const { send, calls } = build();
    const response = await send(
      "POST",
      { "sec-fetch-site": "cross-site", ...CLIENT },
      '{"zz-unknown-key":1}',
    );
    expect(response.status).toBe(403);
    expect(calls()).toBe(0);
  });

  it.each(["PUT", "PATCH", "DELETE"])("applies to %s as well", async (method) => {
    const { send, calls } = build();
    expect((await send(method, { "sec-fetch-site": "cross-site", ...CLIENT })).status).toBe(403);
    expect((await send(method, { "sec-fetch-site": "same-origin", ...CLIENT })).status).toBe(200);
    expect(calls()).toBe(1);
  });
});
