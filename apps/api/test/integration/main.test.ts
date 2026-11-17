import { createServer } from "node:net";
import {
  type AppLogin,
  cloneTemplate,
  createAppLogin,
  emptyDatabase,
  readTestEnv,
  type TestDatabase,
} from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { main, type Started } from "../../src/main.js";

const testEnv = readTestEnv();
const ROLES = ["owner", "app", "worker", "auth", "readonly"] as const;
let login: AppLogin;
const PEPPER = "pepper-for-main-tests-0123456789ab";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(undefined)));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Only the app role connects, through a login whose password start-up accepts; the others are never opened.
const urlFor = (role: string, db: TestDatabase) =>
  role === "app"
    ? login.url(db.name)
    : `postgres://shoutory_${role}:${role}-test-secret-1@localhost:5432/${db.name}`;

function envFor(db: TestDatabase, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    TZ: "UTC",
    SHOUTORY_ACTIVE_KEY_ID: "k1",
    SHOUTORY_KEK_K1: Buffer.alloc(32, 7).toString("base64"),
    SHOUTORY_HMAC_PEPPER: PEPPER,
    SHOUTORY_SESSION_SECRET: "session-for-main-tests-0123456789a",
    SHOUTORY_SMTP_URL: "smtp://mailer-test:smtp-test-secret-1@mail.invalid:587",
    SHOUTORY_PUBLIC_ORIGIN: "https://app.example.test",
    // Tests listen on loopback only, never on all interfaces.
    SHOUTORY_HOST: "127.0.0.1",
    ...Object.fromEntries(
      ROLES.flatMap((role) => [
        [`SHOUTORY_DATABASE_PASSWORD_${role.toUpperCase()}`, `${role}-test-secret-1`],
        [`SHOUTORY_DATABASE_URL_${role.toUpperCase()}`, urlFor(role, db)],
      ]),
    ),
    ...extra,
  };
}

function io() {
  const err: string[] = [];
  return { err, io: { stdout: () => undefined, stderr: (line: string) => void err.push(line) } };
}

const refusal = (started: Started): number => {
  expect("server" in started).toBe(false);
  return (started as { exitCode: number }).exitCode;
};

let migrated: TestDatabase;
let blank: TestDatabase;
beforeAll(async () => {
  migrated = await cloneTemplate(testEnv, inject("shoutoryTemplate"));
  blank = await emptyDatabase(testEnv);
  login = await createAppLogin(testEnv);
});
afterAll(async () => {
  await migrated.drop();
  await blank.drop();
  await login.drop();
});

describe("process entry refusals", () => {
  it("a worker role refuses to start with one line and exit code 2, before listening", async () => {
    const sink = io();
    const started = await main(
      [],
      envFor(migrated, { SHOUTORY_ROLE: "worker", SHOUTORY_PORT: String(await freePort()) }),
      sink.io,
    );
    expect(refusal(started)).toBe(2);
    expect(sink.err).toHaveLength(1);
  });

  it.each([
    ["a TZ other than UTC", (db: TestDatabase) => envFor(db, { TZ: "Africa/Cairo" }), "TZ"],
    [
      "a missing public origin",
      (db: TestDatabase) => ({ ...envFor(db, {}), SHOUTORY_PUBLIC_ORIGIN: undefined }),
      "SHOUTORY_PUBLIC_ORIGIN",
    ],
  ])(
    "main refuses %s before listening, names it and prints no secret value",
    async (_name, makeEnv, named) => {
      const sink = io();
      const started = await main([], makeEnv(migrated), sink.io);
      expect(refusal(started)).toBeGreaterThan(0);
      const printed = sink.err.join("\n");
      expect(printed).toContain(named);
      expect(printed).not.toContain(PEPPER);
    },
  );

  it("main refuses a missing migration before listening and names it", async () => {
    const sink = io();
    const port = await freePort();
    const started = await main([], envFor(blank, { SHOUTORY_PORT: String(port) }), sink.io);
    expect(refusal(started)).toBeGreaterThan(0);
    expect(sink.err.join("\n")).toMatch(/migrations? .*not applied|run the migrate command/);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});

describe("process entry start", () => {
  it("main starts on a migrated database, answers /healthz and /readyz and closes", async () => {
    const sink = io();
    const port = await freePort();
    const started = await main([], envFor(migrated, { SHOUTORY_PORT: String(port) }), sink.io);
    if (!("server" in started)) throw new Error(`did not start: ${sink.err.join("; ")}`);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    } finally {
      await started.server.close();
    }
  });

  it("a command in argv runs the command entry and returns its exit code without listening", async () => {
    const sink = io();
    const started = await main(["nonsense"], envFor(migrated, {}), sink.io);
    expect(refusal(started)).toBe(2);
  });
});
