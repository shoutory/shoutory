import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneTemplate,
  createRoleLogin,
  emptyDatabase,
  type RoleLogin,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "@shoutory/db/testing";
import { closeEgress } from "@shoutory/provider-sdk/egress";
import { createOperatorPolicy } from "@shoutory/provider-sdk/egress/policy";
import { listenLoopback } from "@shoutory/provider-sdk/loopback";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { main, type Started } from "../../src/main.js";

vi.mock("@shoutory/provider-sdk/egress/policy", async (original) => {
  const actual = await original<typeof import("@shoutory/provider-sdk/egress/policy")>();
  return { ...actual, createOperatorPolicy: vi.fn(actual.createOperatorPolicy) };
});
vi.mock("@shoutory/provider-sdk/egress", async (original) => {
  const actual = await original<typeof import("@shoutory/provider-sdk/egress")>();
  return { ...actual, closeEgress: vi.fn(actual.closeEgress) };
});

const testEnv = readTestEnv();
const ROLES = ["owner", "app", "worker", "auth", "readonly"] as const;
const logins: Partial<Record<"app" | "worker", RoleLogin>> = {};
const PEPPER = "pepper-for-main-tests-0123456789ab";

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listenLoopback(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Only the app and worker roles connect, through logins whose passwords start-up accepts; the others are never opened.
const urlFor = (role: string, db: TestDatabase) =>
  role === "app" || role === "worker"
    ? (logins[role] as RoleLogin).url(db.name)
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
    SHOUTORY_MAIL_FROM: "noreply@mail.example.test",
    // Tests listen on loopback only, never on all interfaces; the role is HTTP only unless a test asks for more.
    SHOUTORY_HOST: "127.0.0.1",
    SHOUTORY_ROLE: "api",
    SHOUTORY_SCRATCH_DIR: scratch,
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
let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "main-scratch-"));
  migrated = await cloneTemplate(testEnv, inject("shoutoryTemplate"));
  blank = await emptyDatabase(testEnv);
  logins.app = await createRoleLogin(testEnv, "app");
  logins.worker = await createRoleLogin(testEnv, "worker");
});
afterAll(async () => {
  await migrated.drop();
  await blank.drop();
  await Promise.all(Object.values(logins).map((login) => login.drop()));
  await rm(scratch, { recursive: true, force: true });
});

// `worker` runs no HTTP, `all` runs HTTP and the worker in one process; both beat before the start returns.
describe("process roles", () => {
  it.each(["worker", "all"] as const)("role %s beats at once, and only `all` listens", async (role) => {
    const db = await cloneTemplate(testEnv, inject("shoutoryTemplate"));
    const sink = io();
    const port = await freePort();
    const started = await main([], envFor(db, { SHOUTORY_ROLE: role, SHOUTORY_PORT: String(port) }), sink.io);
    try {
      const beats = await withAdminClient(testEnv, db.name, (admin) =>
        admin.query("SELECT role FROM app.worker_heartbeats"),
      );
      expect(beats.rows).toEqual([{ role }]);
      expect("server" in started).toBe(role === "all");
      if (role === "worker") await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    } finally {
      const running = "server" in started ? started.server : "worker" in started ? started.worker : undefined;
      await running?.close();
      await db.drop();
    }
  });
});

describe("process entry refusals", () => {
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

  // An endpoint can carry userinfo or a token: the refusal names the setting and prints none of the value. The telemetry
  // module runs when `main` is first imported, so the env is stubbed and the modules are reset before a fresh import.
  it("main refuses a bad telemetry endpoint with exit code 1, names it and prints no part of its value", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://user:endpoint-canary-0001@");
    vi.resetModules();
    try {
      const { main: fresh } = await import("../../src/main.js");
      const sink = io();
      const started = await fresh([], envFor(migrated, {}), sink.io);
      expect(refusal(started)).toBe(1);
      expect(sink.err.join("\n")).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
      expect(sink.err.join("\n")).not.toContain("endpoint-canary-0001");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("main refuses a missing migration before listening and names it", async () => {
    const sink = io();
    const port = await freePort();
    const started = await main([], envFor(blank, { SHOUTORY_PORT: String(port) }), sink.io);
    expect(refusal(started)).toBeGreaterThan(0);
    expect(sink.err.join("\n")).toMatch(/migrations? .*not applied|run the migrate command/);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});

describe("process entry and held key ids", () => {
  it("main refuses a sealed row whose key id has no loaded key before listening, and names the key id", async () => {
    const held = await cloneTemplate(testEnv, inject("shoutoryTemplate"));
    try {
      await withAdminClient(testEnv, held.name, (admin) =>
        admin.query(
          `INSERT INTO app.email_outbox (id, recipient, template, locale, vars, link_ciphertext, link_iv, link_auth_tag,
               link_wrap_iv, link_wrap_tag, link_wrapped_dek, link_key_id, link_format_version, link_generation, link_digest)
             VALUES (uuidv7(), 'held-1@example.test', 'verify_email', 'en', '{}', '\\x01', '\\x01', '\\x01', '\\x01', '\\x01',
               '\\x01', 'held', 1, 0, $1)`,
          ["d".repeat(64)],
        ),
      );
      const sink = io();
      const port = await freePort();
      const started = await main([], envFor(held, { SHOUTORY_PORT: String(port) }), sink.io);
      expect(refusal(started)).toBeGreaterThan(0);
      expect(sink.err.join("\n")).toContain("held");
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    } finally {
      await held.drop();
    }
  });
});

describe("the egress policy", () => {
  it("one policy object serves all four callers and its pools are closed at shutdown", async () => {
    vi.mocked(createOperatorPolicy).mockClear();
    vi.mocked(closeEgress).mockClear();
    const sink = io();
    const port = await freePort();
    const started = await main(
      [],
      envFor(migrated, { SHOUTORY_PORT: String(port), SHOUTORY_ROLE: "all" }),
      sink.io,
    );
    if (!("server" in started)) throw new Error(`did not start: ${sink.err.join("; ")}`);
    expect(createOperatorPolicy).toHaveBeenCalledTimes(1);
    expect(closeEgress).not.toHaveBeenCalled();
    await started.server.close();
    const [operator] = vi.mocked(createOperatorPolicy).mock.results;
    expect(vi.mocked(closeEgress).mock.calls).toEqual([[operator?.value]]);
  });
});

describe("process entry start", () => {
  it("main starts on a migrated database, answers /healthz and /readyz and closes", async () => {
    const sink = io();
    const port = await freePort();
    // Role `all` runs the worker too, so its first beat makes /readyz ready.
    const started = await main(
      [],
      envFor(migrated, { SHOUTORY_PORT: String(port), SHOUTORY_ROLE: "all" }),
      sink.io,
    );
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
