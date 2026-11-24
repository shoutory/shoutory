import { SealedSecret } from "@shoutory/core/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, startFixture } from "./harness.js";

const PASSWORD = "password-test-1234";

const HOOK_CANARY = "hook-canary-9b2d4e61";

// A pepper whose use throws on the third call once armed: a sign-in spends two buckets, then the session-create hook
// digests the client address, so the hook is what fails, with the secret in its message.
class FailingPepper extends SealedSecret {
  armed = false;
  private calls = 0;
  constructor() {
    super("auth-pepper-for-tests-0123456789abcdef");
  }
  override expose(): string {
    if (this.armed && ++this.calls === 3) throw new Error(`hook failed with ${HOOK_CANARY}`);
    return super.expose();
  }
}

describe("a planted canary never leaves the process through a failing database hook", () => {
  it("a throw inside the session-create hook answers 500 and leaks no secret", async () => {
    const pepper = new FailingPepper();
    const fx = await startFixture({ pepper, secrets: [HOOK_CANARY] });
    try {
      const email = "hook-1@example.test";
      await fx.signedIn(email);
      pepper.armed = true;
      const answer = await fx.request("/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
      expect(answer.status).toBe(500);
      const surfaces = [await answer.text(), [...answer.headers.entries()].join("\n"), fx.logged.join("")];
      expect(surfaces[2]).toContain("request failed");
      for (const surface of surfaces) expect(surface).not.toContain(HOOK_CANARY);
    } finally {
      await fx.close();
    }
    // A fixture and four memory-hard hashes, run beside the 100-sign-in lockout row: the default limit is too short.
  }, 30_000);
});

// The canary is the email local part, so it is a parameter of the library's first statement. Revoking the library
// role's read of the user table makes that statement fail inside Drizzle (its error echoes the parameters) while the
// throttle, on other tables, keeps working: the request really reaches the library.
const MAIL_CANARY = "canary-mail-4f9a1c7e";
const spellings = (value: string): string[] => [
  value,
  encodeURIComponent(value),
  Buffer.from(value).toString("hex"),
  Buffer.from(value).toString("base64"),
  JSON.stringify(value).slice(1, -1),
];

describe("a planted canary never leaves the process through the sign-in routes", () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await startFixture();
    await fx.admin((client) => client.query('REVOKE SELECT ON auth."user" FROM shoutory_auth'));
  });
  afterAll(() => fx.close());

  it.each([
    ["sign-in", "/api/auth/sign-in/email", { email: `${MAIL_CANARY}@example.test`, password: PASSWORD }],
    [
      "sign-up",
      "/api/auth/sign-up/email",
      { name: "Canary", email: `${MAIL_CANARY}@example.test`, password: PASSWORD },
    ],
    ["password reset request", "/api/auth/request-password-reset", { email: `${MAIL_CANARY}@example.test` }],
  ])(
    "%s: a failing query carrying the canary as a parameter is absent from every surface in every form",
    async (_name, path, body) => {
      const response = await fx.request(path, { body });
      expect(response.status).toBe(500);
      const surfaces = [
        await response.text(),
        [...response.headers.entries()].join("\n"),
        fx.logged.join(""),
      ];
      expect(surfaces[2]).toContain("request failed");
      for (const surface of surfaces) {
        for (const form of spellings(MAIL_CANARY)) expect(surface).not.toContain(form);
      }
    },
  );
});

const PASSWORD_CANARY = "password-canary-7d2e91b4-long";

describe("a password never leaves through the breached-password check", () => {
  it("the range request names only the hash prefix, and an outage logs no password in any form", async () => {
    const fx = await startFixture({ secrets: [PASSWORD_CANARY] });
    try {
      const body = { name: "Canary", email: "hibp-canary-1@example.test", password: PASSWORD_CANARY };
      const first = await fx.request("/api/auth/sign-up/email", { body });
      fx.hibp.down = true;
      const second = await fx.request("/api/auth/sign-up/email", {
        body: { ...body, email: "hibp-canary-2@example.test" },
      });
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(fx.logged.join("")).toContain("the breached-password check is unavailable");
      for (const surface of [fx.logged.join(""), fx.hibp.urls.join("\n")]) {
        for (const form of spellings(PASSWORD_CANARY)) expect(surface).not.toContain(form);
      }
      for (const url of fx.hibp.urls) expect(url).toMatch(/\/range\/[0-9A-F]{5}$/);
    } finally {
      await fx.close();
    }
  });
});
