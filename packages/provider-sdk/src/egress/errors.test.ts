import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { EgressError, wrapNetworkError } from "./errors.js";

const CANARY = "egress-canary&token=1";
const spellings = [
  CANARY,
  encodeURIComponent(CANARY),
  Buffer.from(CANARY).toString("hex"),
  Buffer.from(CANARY).toString("base64"),
  JSON.stringify(CANARY).slice(1, -1),
];

function leakyError(): Error {
  const inner = new Error(`connect ECONNREFUSED https://example.com/v1/post?token=${CANARY}`);
  const outer = new TypeError(`fetch failed: https://example.com/v1/post?token=${CANARY}`, { cause: inner });
  Object.assign(outer, {
    config: { headers: { authorization: `Bearer ${CANARY}` } },
    url: `https://example.com/?t=${CANARY}`,
  });
  return outer;
}

describe("EgressError safe wrapping", () => {
  it("never carries the original error: the canary is absent in every spelling and place", () => {
    const wrapped = wrapNetworkError(leakyError(), "example.com");
    expect(wrapped).toBeInstanceOf(EgressError);
    expect(wrapped.cause).toBeUndefined();
    const shown = [
      wrapped.message,
      wrapped.stack ?? "",
      String(wrapped),
      JSON.stringify(wrapped),
      inspect(wrapped, { depth: 10, showHidden: true }),
    ].join("\n");
    for (const spelling of spellings) expect(shown).not.toContain(spelling);
  });

  // A reset can arrive after the request was written, so it must never read as "nothing was sent" (an unconfirmed outcome is unknown, never a plain failure).
  it.each([
    ["ECONNREFUSED", "connect", "none"],
    ["UND_ERR_CONNECT_TIMEOUT", "connect_timeout", "none"],
    ["ENOTFOUND", "dns", "none"],
    ["EAI_AGAIN", "dns", "none"],
    ["ENODATA", "dns", "none"],
    ["ETIMEOUT", "dns", "none"],
    ["ESERVFAIL", "dns", "none"],
    ["ECONNRESET", "network", "possible"],
    ["UND_ERR_HEADERS_TIMEOUT", "timeout", "possible"],
    ["UND_ERR_RES_EXCEEDED_MAX_SIZE", "size_exceeded", "possible"],
  ])("a %s failure is class %s with effect %s", (code, expectedClass, effect) => {
    const wrapped = wrapNetworkError(Object.assign(new Error("failed"), { code }), "example.com");
    expect([wrapped.class, wrapped.effect]).toEqual([expectedClass, effect]);
  });
});
