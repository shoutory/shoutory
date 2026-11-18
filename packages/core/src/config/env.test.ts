import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { assertKeyIdsLoaded, EnvKeyProvider, KeyError } from "../crypto/keys.js";
import { assertUtc, ConfigError, type Env, parseEnv, parseKeyRing } from "./env.js";

const b64 = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const ROLES = ["OWNER", "APP", "WORKER", "AUTH", "READONLY"] as const;

const valid: Record<string, string> = {
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: b64(7),
  SHOUTORY_HMAC_PEPPER: "pepper-for-config-tests-0123456789",
  SHOUTORY_SESSION_SECRET: "session-for-config-tests-0123456789",
  SHOUTORY_SMTP_URL: "smtp://mailer-test:smtp-test-secret-1@mail.invalid:587",
  SHOUTORY_PUBLIC_ORIGIN: "https://app.example.test",
  ...Object.fromEntries(
    ROLES.map((r) => [`SHOUTORY_DATABASE_PASSWORD_${r}`, `${r.toLowerCase()}-test-secret-1`]),
  ),
  ...Object.fromEntries(
    ROLES.map((r) => [
      `SHOUTORY_DATABASE_URL_${r}`,
      `postgres://shoutory_${r.toLowerCase()}:${r.toLowerCase()}-test-secret-1@db.invalid:5432/shoutory`,
    ]),
  ),
};
const without = (key: string): Env => Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));
const withValue = (key: string, value: string): Env => ({ ...valid, [key]: value });

/** The refusal of an environment: the variable it names and everything an error prints. */
function refusal(env: Env): { variable: string; shown: string } | undefined {
  try {
    parseEnv(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return { variable: error.variable, shown: `${String(error)}\n${inspect(error, { depth: 6 })}` };
    }
    throw error;
  }
  return undefined;
}
const refusedVariable = (env: Env) => refusal(env)?.variable;

// Values the repository ships as examples (README, compose when present): a secret equal to one is refused.
function shippedExamples(): [string, string][] {
  const files = ["../../../../README.md", "../../../../docker/compose.yml"];
  const found: [string, string][] = [];
  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(new URL(file, import.meta.url), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const m of text.matchAll(/(SHOUTORY_[A-Z_0-9]+)[=:]\s*"?([^\s"]+)"?/g)) {
      const value = m[2] ?? "";
      // A compose interpolation token (`${VAR:?...}`) is not an example value.
      if (!value.includes("${")) found.push([m[1] ?? "", value]);
    }
  }
  return found;
}

describe("start-up refusal", () => {
  it("accepts a complete, valid environment", () => {
    expect(refusedVariable(valid)).toBeUndefined();
    expect(parseEnv(valid).keys.activeKeyId()).toBe("k1");
  });

  const secretKeys = Object.keys(valid);
  it.each(secretKeys)("refuses %s missing (no secret has a default)", (key) => {
    expect(refusedVariable(without(key))).toBe(key);
  });
  it.each(secretKeys)("refuses %s empty", (key) => {
    expect(refusedVariable(withValue(key, ""))).toBe(key);
  });

  it.each([
    ["an all-zero KEK", "SHOUTORY_KEK_K1", Buffer.alloc(32).toString("base64")],
    ["a 31-byte KEK", "SHOUTORY_KEK_K1", Buffer.alloc(31, 7).toString("base64")],
    ["a KEK that is not base64", "SHOUTORY_KEK_K1", "not base64 !!"],
    ["a pepper under 32 bytes", "SHOUTORY_HMAC_PEPPER", "p".repeat(31)],
    ["a session secret under 32 bytes", "SHOUTORY_SESSION_SECRET", "s".repeat(31)],
    ["an active key id outside the alphabet", "SHOUTORY_ACTIVE_KEY_ID", "K_1"],
    ["an active key id over 32 characters", "SHOUTORY_ACTIVE_KEY_ID", "k".repeat(33)],
    ["a set-but-empty retired KEK", "SHOUTORY_KEK_OLD", ""],
    ["a KEK variable whose suffix is outside the id alphabet", "SHOUTORY_KEK_has.dot", b64(3)],
    ["a KEK variable whose suffix is over 32 characters", `SHOUTORY_KEK_${"K".repeat(33)}`, b64(3)],
    [
      "a database URL with a malformed percent-encoded password",
      "SHOUTORY_DATABASE_URL_APP",
      "postgres://shoutory_app:%zz@db.invalid:5432/shoutory",
    ],
  ])("refuses %s and never prints the rejected value", (_name, key, value) => {
    const refused = refusal(withValue(key, value));
    expect(refused?.variable).toBe(key);
    if (value) expect(refused?.shown).not.toContain(value);
  });

  it("refuses an active key id that has no loaded key", () => {
    expect(refusedVariable(withValue("SHOUTORY_ACTIVE_KEY_ID", "k9"))).toBe("SHOUTORY_KEK_K9");
  });
});

describe("start-up: shipped examples and printing", () => {
  // The shipped examples (README, compose) are format-valid, so only the known-default rule can refuse them.
  it("refuses every shipped example value, and the examples cover the pepper, session secret and a KEK", () => {
    const secrets = Object.keys(valid).filter((k) => k !== "SHOUTORY_ACTIVE_KEY_ID");
    const examples = shippedExamples()
      .map(([key, value]): [string, string] => [
        key.startsWith("SHOUTORY_KEK_") ? "SHOUTORY_KEK_K1" : key,
        value,
      ])
      .filter(([key]) => secrets.includes(key));
    const covered = new Set(examples.map(([key]) => key));
    for (const key of ["SHOUTORY_HMAC_PEPPER", "SHOUTORY_SESSION_SECRET", "SHOUTORY_KEK_K1"]) {
      expect(covered.has(key), `${key} has no shipped example`).toBe(true);
    }
    for (const [key, value] of examples) {
      const refused = refusal(withValue(key, value));
      expect(refused?.variable).toBe(key);
      expect(refused?.shown).not.toContain(value);
    }
  });

  it("never prints a secret value in the parsed config", () => {
    const config = parseEnv(valid);
    const shown = [JSON.stringify(config), String(config), inspect(config, { depth: 6 })].join("\n");
    for (const key of Object.keys(valid).filter(
      (k) => k !== "SHOUTORY_ACTIVE_KEY_ID" && k !== "SHOUTORY_PUBLIC_ORIGIN",
    )) {
      expect(shown).not.toContain(valid[key] as string);
    }
  });
});

describe("start-up: time zone and key ids", () => {
  it.each([
    ["UTC", true],
    [undefined, false],
    ["Pacific/Chatham", false],
    ["Europe/London", false],
    ["", false],
  ])("assertUtc with TZ=%s", (tz, ok) => {
    const run = () => assertUtc({ TZ: tz });
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(ConfigError);
  });

  const ring = new EnvKeyProvider({
    SHOUTORY_ACTIVE_KEY_ID: "k1",
    SHOUTORY_KEK_K1: b64(1),
    SHOUTORY_KEK_OLD_1: b64(2),
  });
  it.each([
    [["k1"], true],
    [["k1", "old-1"], true],
    [["k1", "k2"], false],
    [["missing"], false],
  ])("assertKeyIdsLoaded for %j", (inUse, ok) => {
    const run = () => assertKeyIdsLoaded(inUse, ring);
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(KeyError);
  });
});

describe("start-up: HTTP settings", () => {
  it("reads the origin as an exact origin, the port with its default and the proxy list with an empty default", () => {
    const config = parseEnv(withValue("SHOUTORY_PUBLIC_ORIGIN", "HTTPS://App.Example.test"));
    expect(config.publicOrigin).toBe("https://app.example.test");
    expect(config.port).toBe(3000);
    expect(config.trustedProxies).toEqual([]);
    expect(parseEnv(withValue("SHOUTORY_PUBLIC_ORIGIN", "http://localhost:5173")).publicOrigin).toBe(
      "http://localhost:5173",
    );
  });

  it("reads a set port and a comma-separated CIDR list", () => {
    const config = parseEnv({
      ...valid,
      SHOUTORY_PORT: "8080",
      SHOUTORY_TRUSTED_PROXIES: "10.0.0.0/8, fd00::/8,192.0.2.7/32",
    });
    expect(config.port).toBe(8080);
    expect(config.trustedProxies).toEqual(["10.0.0.0/8", "fd00::/8", "192.0.2.7/32"]);
  });

  it.each(["127.0.0.1", "::1"])("reads the listen address %s; unset means no host", (host) => {
    expect(parseEnv({ ...valid, SHOUTORY_HOST: host }).host).toBe(host);
    expect(parseEnv(valid).host).toBeUndefined();
  });

  it.each([
    ["an origin with a path", "SHOUTORY_PUBLIC_ORIGIN", "https://app.example.test/app"],
    ["an origin with userinfo", "SHOUTORY_PUBLIC_ORIGIN", "https://user:pw@app.example.test"],
    ["an origin with a query", "SHOUTORY_PUBLIC_ORIGIN", "https://app.example.test?x=1"],
    ["an origin with a fragment", "SHOUTORY_PUBLIC_ORIGIN", "https://app.example.test#top"],
    ["an origin that is not http or https", "SHOUTORY_PUBLIC_ORIGIN", "ftp://app.example.test"],
    ["an origin that is not a URL", "SHOUTORY_PUBLIC_ORIGIN", "app.example.test"],
    ["a port of 0", "SHOUTORY_PORT", "0"],
    ["a port over 65535", "SHOUTORY_PORT", "65536"],
    ["a port that is not an integer", "SHOUTORY_PORT", "80.5"],
    ["a proxy entry that is not a CIDR", "SHOUTORY_TRUSTED_PROXIES", "10.0.0.0/8,not-a-network"],
    ["a proxy entry with a prefix out of range", "SHOUTORY_TRUSTED_PROXIES", "10.0.0.0/33"],
    ["a proxy entry that is a bare address", "SHOUTORY_TRUSTED_PROXIES", "10.0.0.1"],
    ["a role outside api, worker and all", "SHOUTORY_ROLE", "scheduler"],
    ["a listen address that is a host name", "SHOUTORY_HOST", "localhost"],
  ])("refuses %s and names the variable", (_name, key, value) => {
    expect(refusedVariable(withValue(key, value))).toBe(key);
  });

  it("requires the origin for the api and all roles but not for a worker", () => {
    expect(refusedVariable({ ...without("SHOUTORY_PUBLIC_ORIGIN"), SHOUTORY_ROLE: "api" })).toBe(
      "SHOUTORY_PUBLIC_ORIGIN",
    );
    expect(refusedVariable(without("SHOUTORY_PUBLIC_ORIGIN"))).toBe("SHOUTORY_PUBLIC_ORIGIN");
    expect(
      refusedVariable({ ...without("SHOUTORY_PUBLIC_ORIGIN"), SHOUTORY_ROLE: "worker" }),
    ).toBeUndefined();
  });
});

describe("start-up refusal of the library's own environment switches", () => {
  // The authentication library reads these itself (secret, URL, trusted origins, telemetry) and would override us.
  it.each([
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_SECRETS",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_TRUSTED_ORIGINS",
    "BETTER_AUTH_TELEMETRY",
    "AUTH_SECRET",
  ])("refuses %s, names it and never prints its value", (variable) => {
    const found = refusal(withValue(variable, "library-switch-value-1"));
    expect(found?.variable).toBe(variable);
    expect(found?.shown).not.toContain("library-switch-value-1");
  });

  it("accepts an unrelated variable that only looks similar", () => {
    expect(refusedVariable(withValue("OAUTH_CLIENT", "x"))).toBeUndefined();
  });
});

describe("parseKeyRing", () => {
  const example = "c2hvdXRvcnktZXhhbXBsZS1rZWstMDEyMzQ1Njc4OSE=";

  it("loads the key variables alone and refuses an example KEK and a missing active key", () => {
    const ring = parseKeyRing({ SHOUTORY_ACTIVE_KEY_ID: "k1", SHOUTORY_KEK_K1: b64(7) });
    expect(ring.activeKeyId()).toBe("k1");
    expect(() => parseKeyRing({ SHOUTORY_ACTIVE_KEY_ID: "k1", SHOUTORY_KEK_K1: example })).toThrow(
      /known example value/,
    );
    expect(() => parseKeyRing({ SHOUTORY_KEK_K1: b64(7) })).toThrow(ConfigError);
  });
});
