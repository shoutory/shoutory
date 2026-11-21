import { describe, expect, it, vi } from "vitest";
import { collectSecrets, run } from "./main.js";
import { migrateCommand } from "./migrate.js";

// The real command stays in place; one row makes it throw so the assertion is on `run`'s own output.
vi.mock("./migrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./migrate.js")>();
  return { migrateCommand: vi.fn(actual.migrateCommand) };
});

const CANARY = 'cli-canary"v\\1/a b+c=d';
const spellings = (v: string) => [
  v,
  encodeURIComponent(v),
  Buffer.from(v).toString("hex"),
  Buffer.from(v).toString("base64"),
  JSON.stringify(v).slice(1, -1),
];

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
  };
}

describe("shoutory command entry", () => {
  it.each([[[]], [["nonsense"]], [["secrets"]], [["secrets", "rotate"]], [["migrate", "now"]]])(
    "an unknown or missing command (%j) writes one usage line and returns 2",
    async (argv) => {
      const sink = io();
      expect(await run(argv, {}, sink.io)).toBe(2);
      expect(sink.err).toHaveLength(1);
      expect(sink.err[0]).toContain("migrate");
      expect(sink.out).toEqual([]);
    },
  );

  it.each([["secrets check"], ["secrets reseal"]])(
    "%s reaches its command: with no worker URL it reports that variable and fails",
    async (command) => {
      const sink = io();
      expect(await run(command.split(" "), {}, sink.io)).toBe(1);
      expect(sink.err.join("\n")).toContain("SHOUTORY_DATABASE_URL_WORKER");
    },
  );

  it("migrate reaches migrateCommand: with no owner URL it reports that variable and fails", async () => {
    const sink = io();
    expect(await run(["migrate"], {}, sink.io)).not.toBe(0);
    expect(sink.err.join("\n")).toContain("SHOUTORY_DATABASE_URL_OWNER");
  });
});

describe("a command failure is printed without a registered secret", () => {
  it.each(spellings(CANARY))("the message embeds the secret as %s", async (form) => {
    vi.mocked(migrateCommand).mockRejectedValueOnce(new Error(`connect failed near ${form}`));
    const sink = io();
    const code = await run(["migrate"], { SHOUTORY_HMAC_PEPPER: CANARY }, sink.io);
    expect(code).toBe(1);
    expect(sink.err).toHaveLength(1);
    for (const spelling of spellings(CANARY)) expect(sink.err[0]).not.toContain(spelling);
  });
});

describe("collectSecrets", () => {
  it("takes set secret variables, every KEK and the decoded URL password, and skips short values", () => {
    const secrets = collectSecrets({
      SHOUTORY_HMAC_PEPPER: "planted-pepper-value-0001",
      SHOUTORY_SESSION_SECRET: "short",
      SHOUTORY_KEK_ONE: "planted-kek-value-0001",
      SHOUTORY_SMTP_URL: "smtps://mailer:p%40ss-word-0001@mail.example.test:465",
      SHOUTORY_DATABASE_URL_APP: "postgres://app:db-password-0001@db.example.test/shoutory",
      SHOUTORY_DATABASE_PASSWORD_APP: "",
      SHOUTORY_S3_ACCESS_KEY_ID: "planted-s3-access-value",
      SHOUTORY_S3_SECRET_ACCESS_KEY: "planted-s3-secret-value",
    });
    expect(secrets.sort()).toEqual(
      [
        "db-password-0001",
        "p@ss-word-0001",
        "planted-kek-value-0001",
        "planted-pepper-value-0001",
        "planted-s3-access-value",
        "planted-s3-secret-value",
        "postgres://app:db-password-0001@db.example.test/shoutory",
        "smtps://mailer:p%40ss-word-0001@mail.example.test:465",
      ].sort(),
    );
  });

  it.each(
    ["OWNER", "APP", "WORKER", "AUTH", "READONLY"].flatMap((role) => [
      [
        `SHOUTORY_DATABASE_URL_${role}`,
        `postgres://${role.toLowerCase()}:planted-db-${role}@db.example.test/shoutory`,
      ],
      [`SHOUTORY_DATABASE_PASSWORD_${role}`, `planted-role-password-${role}`],
    ]),
  )("collects %s so the logger never prints it", (name, value) => {
    expect(collectSecrets({ [name as string]: value })).toContain(value);
  });
});
