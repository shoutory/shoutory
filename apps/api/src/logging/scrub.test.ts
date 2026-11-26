import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { collectSecrets } from "./scrub.js";

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

  it.each([["OTEL_EXPORTER_OTLP_HEADERS"], ["OTEL_EXPORTER_OTLP_TRACES_HEADERS"]])(
    "a header-value canary in %s is collected and absent from every logged line",
    (name) => {
      const env = { [name]: "authorization=Bearer%20header-canary-0001,x-api-key=other-canary-0002" };
      const secrets = collectSecrets(env);
      expect(secrets).toEqual(expect.arrayContaining(["Bearer header-canary-0001", "other-canary-0002"]));
      const lines: string[] = [];
      const logger = createLogger({ secrets, stream: { write: (line) => void lines.push(line) } });
      logger.info({ note: "Bearer header-canary-0001 and other-canary-0002" }, "header values");
      expect(lines.join("")).not.toMatch(/header-canary-0001|other-canary-0002/);
    },
  );

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

describe("a Bearer header value", () => {
  it("masks its token alone in a logged line", () => {
    const secrets = collectSecrets({
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20token-only-canary-0001",
    });
    const lines: string[] = [];
    const logger = createLogger({ secrets, stream: { write: (line) => void lines.push(line) } });
    logger.info({ note: "sent token-only-canary-0001 upstream" }, "token part");
    expect(lines.join("")).not.toContain("token-only-canary-0001");
  });
});
