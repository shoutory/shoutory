import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { assertKeyIdsLoaded, EnvKeyProvider, KeyError } from "../crypto/keys.js";
import { assertUtc, ConfigError, type Env, parseEnv, parseKeyRing, parseStorageEnv } from "./env.js";

const b64 = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const ROLES = ["APP", "WORKER", "AUTH"] as const;

const valid: Record<string, string> = {
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: b64(7),
  SHOUTORY_HMAC_PEPPER: "pepper-for-config-tests-0123456789",
  SHOUTORY_SESSION_SECRET: "session-for-config-tests-0123456789",
  SHOUTORY_SMTP_URL: "smtp://mailer-test:smtp-test-secret-1@mail.invalid:587",
  SHOUTORY_PUBLIC_ORIGIN: "https://app.example.test",
  SHOUTORY_MAIL_FROM: "noreply@mail.example.test",
  ...Object.fromEntries(
    ROLES.map((r) => [
      `SHOUTORY_DATABASE_URL_${r}`,
      `postgres://shoutory_${r.toLowerCase()}:${r.toLowerCase()}-test-secret-1@db.invalid:5432/shoutory`,
    ]),
  ),
};
const without = (key: string): Env => Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));
const withValue = (key: string, value: string): Env => ({ ...valid, [key]: value });

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

  const pepper = valid.SHOUTORY_HMAC_PEPPER as string;
  it.each([
    ["a session secret equal to the pepper", { SHOUTORY_SESSION_SECRET: pepper }, "SHOUTORY_SESSION_SECRET"],
    ["a KEK equal to the pepper", { SHOUTORY_HMAC_PEPPER: b64(7) }, "SHOUTORY_KEK_K1"],
    ["a KEK equal to the session secret", { SHOUTORY_SESSION_SECRET: b64(7) }, "SHOUTORY_KEK_K1"],
    ["two equal KEKs", { SHOUTORY_KEK_OLD: b64(7) }, "SHOUTORY_KEK_OLD"],
  ])("refuses %s, naming the later variable and never the value", (_name, change, variable) => {
    const refused = refusal({ ...valid, ...change });
    expect(refused?.variable).toBe(variable);
    expect(refused?.shown).not.toContain(Object.values(change)[0]);
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
      (k) => !["SHOUTORY_ACTIVE_KEY_ID", "SHOUTORY_PUBLIC_ORIGIN", "SHOUTORY_MAIL_FROM"].includes(k),
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

describe("start-up: release channel", () => {
  it.each([
    ["unset", undefined, "stable"],
    ["stable", "stable", "stable"],
    ["beta", "beta", "beta"],
    ["nightly", "nightly", "nightly"],
  ])("reads the release channel when it is %s", (_name, value, channel) => {
    const env = value === undefined ? valid : withValue("SHOUTORY_RELEASE_CHANNEL", value);
    expect((parseEnv(env) as unknown as { releaseChannel: string }).releaseChannel).toBe(channel);
  });

  it.each(["canary", "", "Stable"])("refuses the value %j and names the variable", (value) => {
    expect(refusedVariable(withValue("SHOUTORY_RELEASE_CHANNEL", value))).toBe("SHOUTORY_RELEASE_CHANNEL");
  });
});

describe("start-up: mail senders", () => {
  const mail = valid;
  const noFrom = (role: string): Env => ({ ...without("SHOUTORY_MAIL_FROM"), SHOUTORY_ROLE: role });

  it.each(["worker", "all"])("requires SHOUTORY_MAIL_FROM for the %s role, which sends mail", (role) => {
    expect(refusedVariable(noFrom(role))).toBe("SHOUTORY_MAIL_FROM");
  });

  it("does not require SHOUTORY_MAIL_FROM for the api role", () => {
    expect(refusedVariable(noFrom("api"))).toBeUndefined();
  });

  it.each([
    ["a bare address", "noreply@mail.example.test"],
    ["a display name and an address", "Shoutory <noreply@mail.example.test>"],
  ])("accepts %s as the sender and the marketing sender", (_name, address) => {
    expect(
      refusedVariable({ ...mail, SHOUTORY_MAIL_FROM: address, SHOUTORY_MAIL_MARKETING_FROM: address }),
    ).toBeUndefined();
  });

  it.each([
    ["SHOUTORY_MAIL_FROM", "not an address"],
    ["SHOUTORY_MAIL_FROM", "Shoutory <noreply>"],
    ["SHOUTORY_MAIL_MARKETING_FROM", "news@"],
    ["SHOUTORY_MAIL_DKIM_SELECTOR", "has space"],
  ])("refuses %s = %j and names the variable", (key, value) => {
    expect(refusedVariable({ ...mail, [key]: value })).toBe(key);
  });

  it("leaves the marketing sender and the DKIM selector optional", () => {
    expect(refusedVariable(mail)).toBeUndefined();
  });
});

describe("start-up: storage settings", () => {
  it("defaults to the filesystem driver on /data and reads a set directory", () => {
    expect(parseEnv(valid).storage).toEqual({ driver: "fs", dataDir: "/data" });
    expect(parseStorageEnv({ SHOUTORY_DATA_DIR: "/srv/shoutory" })).toEqual({
      driver: "fs",
      dataDir: "/srv/shoutory",
    });
    expect(parseStorageEnv({ SHOUTORY_DATA_DIR: "C:\\shoutory\\data" })).toMatchObject({
      dataDir: "C:\\shoutory\\data",
    });
  });

  it.each([
    ["a relative data directory", "SHOUTORY_DATA_DIR", "data/files"],
    ["an empty data directory", "SHOUTORY_DATA_DIR", ""],
    ["a driver that does not exist", "SHOUTORY_STORAGE_DRIVER", "gcs"],
  ])("refuses %s and names the variable", (_name, key, value) => {
    expect(refusedVariable(withValue(key, value))).toBe(key);
  });
});

describe("start-up: the ffprobe path", () => {
  it("is optional (video probing is off without it, or with an empty value over the image's) and an absolute path is taken as given", () => {
    expect(parseEnv(valid).ffprobePath).toBeUndefined();
    expect(parseEnv(withValue("SHOUTORY_FFPROBE_PATH", "")).ffprobePath).toBeUndefined();
    expect(parseEnv(withValue("SHOUTORY_FFPROBE_PATH", "/usr/local/bin/ffprobe")).ffprobePath).toBe(
      "/usr/local/bin/ffprobe",
    );
  });

  it.each([
    ["a bare program name, which would be searched on the path", "ffprobe"],
    ["a relative path", "bin/ffprobe"],
    ["a URL", "https://media.example.test/ffprobe"],
  ])("refuses %s and names the variable", (_name, value) => {
    expect(refusedVariable(withValue("SHOUTORY_FFPROBE_PATH", value))).toBe("SHOUTORY_FFPROBE_PATH");
  });
});

describe("start-up: the media scratch folder", () => {
  it("is /data/scratch unless set, takes an absolute path, and refuses a relative one", () => {
    expect(parseEnv(valid).scratchDir).toBe("/data/scratch");
    expect(parseEnv(withValue("SHOUTORY_SCRATCH_DIR", "/var/lib/shoutory/scratch")).scratchDir).toBe(
      "/var/lib/shoutory/scratch",
    );
    expect(refusedVariable(withValue("SHOUTORY_SCRATCH_DIR", "scratch"))).toBe("SHOUTORY_SCRATCH_DIR");
  });
});

describe("start-up: the upload scan hook", () => {
  const scan = (extra: Record<string, string>) => ({ ...valid, ...extra });

  it("is off unless the operator turns it on, and `warn` needs a scanner address (default port 3310)", () => {
    expect(parseEnv(valid).mediaScan).toEqual({ mode: "off" });
    expect(
      parseEnv(scan({ SHOUTORY_MEDIA_SCAN: "warn", SHOUTORY_CLAMAV_HOST: "clamav.internal" })).mediaScan,
    ).toEqual({ mode: "warn", host: "clamav.internal", port: 3310 });
    expect(
      parseEnv(
        scan({ SHOUTORY_MEDIA_SCAN: "warn", SHOUTORY_CLAMAV_HOST: "10.0.0.5", SHOUTORY_CLAMAV_PORT: "3311" }),
      ).mediaScan,
    ).toMatchObject({ host: "10.0.0.5", port: 3311 });
  });

  it.each([
    ["a mode that does not exist", { SHOUTORY_MEDIA_SCAN: "require" }, "SHOUTORY_MEDIA_SCAN"],
    ["warn with no scanner address", { SHOUTORY_MEDIA_SCAN: "warn" }, "SHOUTORY_CLAMAV_HOST"],
    [
      "the metadata address as the scanner",
      { SHOUTORY_MEDIA_SCAN: "warn", SHOUTORY_CLAMAV_HOST: "169.254.169.254" },
      "SHOUTORY_CLAMAV_HOST",
    ],
    [
      "the metadata address written as one decimal number",
      { SHOUTORY_MEDIA_SCAN: "warn", SHOUTORY_CLAMAV_HOST: "2852039166" },
      "SHOUTORY_CLAMAV_HOST",
    ],
    [
      "a scanner address with userinfo or a path",
      { SHOUTORY_MEDIA_SCAN: "warn", SHOUTORY_CLAMAV_HOST: "user@clamav/x" },
      "SHOUTORY_CLAMAV_HOST",
    ],
    [
      "a port outside 1 to 65535",
      { SHOUTORY_MEDIA_SCAN: "warn", SHOUTORY_CLAMAV_HOST: "clamav", SHOUTORY_CLAMAV_PORT: "70000" },
      "SHOUTORY_CLAMAV_PORT",
    ],
  ])("refuses %s and names the variable", (_name, extra, variable) => {
    expect(refusedVariable(scan(extra))).toBe(variable);
  });
});

describe("start-up: web root setting", () => {
  it("is optional: unset serves no web, a set absolute folder is read", () => {
    expect(parseEnv(valid).webRoot).toBeUndefined();
    expect(parseEnv(withValue("SHOUTORY_WEB_ROOT", "/srv/shoutory/web")).webRoot).toBe("/srv/shoutory/web");
    expect(parseEnv(withValue("SHOUTORY_WEB_ROOT", "C:\\shoutory\\web")).webRoot).toBe("C:\\shoutory\\web");
  });

  it.each([
    ["a relative folder", "web/dist"],
    ["an empty value", ""],
  ])("refuses %s and names the variable", (_name, value) => {
    expect(refusedVariable(withValue("SHOUTORY_WEB_ROOT", value))).toBe("SHOUTORY_WEB_ROOT");
  });
});

const S3: Record<string, string> = {
  SHOUTORY_STORAGE_DRIVER: "s3",
  SHOUTORY_S3_ENDPOINT: "https://s3.example.test",
  SHOUTORY_S3_REGION: "eu-west-1",
  SHOUTORY_S3_BUCKET: "media-bucket-for-tests-1",
  SHOUTORY_S3_ACCESS_KEY_ID: "access-key-id-for-tests-1",
  SHOUTORY_S3_SECRET_ACCESS_KEY: "secret-access-key-for-tests-1",
};
const s3With = (key: string, value: string): Env => ({ ...valid, ...S3, [key]: value });
const ENDPOINT_MARKERS = [
  "user-marker",
  "pass-marker",
  "169.254",
  "2852039166",
  "0xa9fea9fe",
  "fd00:ec2",
  "fe80",
  "a9fe",
  "ff9b",
];

describe("start-up: S3 storage endpoint", () => {
  // Each endpoint carries a marker that an error text must never repeat.
  it.each([
    ["userinfo", "https://user-marker:pass-marker@s3.example.test"],
    ["the metadata address", "http://169.254.169.254/latest"],
    ["the metadata address in decimal", "http://2852039166"],
    ["the metadata address in hex", "http://0xa9fea9fe"],
    ["the metadata address as an IPv4-mapped IPv6 literal", "http://[::ffff:169.254.169.254]"],
    ["the IPv6 metadata address", "http://[fd00:ec2::254]"],
    ["the metadata address behind the NAT64 prefix", "http://[64:ff9b::a9fe:a9fe]"],
    ["the metadata address in dotted form behind the NAT64 prefix", "http://[64:ff9b::169.254.169.254]"],
    ["the metadata address in the SIIT translated range", "http://[::ffff:0:a9fe:a9fe]"],
    ["the metadata address as an IPv4-compatible IPv6 address", "http://[::a9fe:a9fe]"],
    ["another link-local IPv4 address", "http://169.254.10.10:9000"],
    ["a link-local IPv6 address", "http://[fe80::1]:9000"],
    ["a scheme other than http and https", "ftp://s3.example.test"],
    ["no URL at all", "s3.example.test"],
  ])("refuses an endpoint with %s, naming the variable and never the value", (_name, endpoint) => {
    const refused = refusal(s3With("SHOUTORY_S3_ENDPOINT", endpoint));
    expect(refused?.variable).toBe("SHOUTORY_S3_ENDPOINT");
    for (const marker of ENDPOINT_MARKERS) expect(refused?.shown).not.toContain(marker);
  });

  it.each(["https://s3.example.test", "http://127.0.0.1:7070", "http://object-store:9000"])(
    "accepts the endpoint %s",
    (endpoint) => {
      expect(refusedVariable(s3With("SHOUTORY_S3_ENDPOINT", endpoint))).toBeUndefined();
    },
  );
});

describe("start-up: S3 public endpoint", () => {
  it("is the endpoint when unset and the given address when set", () => {
    expect(parseStorageEnv(S3)).toMatchObject({ publicEndpoint: "https://s3.example.test" });
    const set = { ...S3, SHOUTORY_S3_PUBLIC_ENDPOINT: "https://files.example.test" };
    expect(parseStorageEnv(set)).toMatchObject({ publicEndpoint: "https://files.example.test" });
  });

  it.each([
    ["userinfo", "https://user-marker:pass-marker@files.example.test"],
    ["the metadata address", "http://169.254.169.254/latest"],
    ["a scheme other than http and https", "ftp://files.example.test"],
  ])("refuses an address with %s, naming the variable and never the value", (_name, value) => {
    const refused = refusal(s3With("SHOUTORY_S3_PUBLIC_ENDPOINT", value));
    expect(refused?.variable).toBe("SHOUTORY_S3_PUBLIC_ENDPOINT");
    for (const marker of ENDPOINT_MARKERS) expect(refused?.shown).not.toContain(marker);
  });
});

describe("start-up: S3 storage settings", () => {
  it.each([
    "SHOUTORY_S3_ENDPOINT",
    "SHOUTORY_S3_REGION",
    "SHOUTORY_S3_BUCKET",
    "SHOUTORY_S3_ACCESS_KEY_ID",
    "SHOUTORY_S3_SECRET_ACCESS_KEY",
  ])("with driver s3 a missing %s fails the parse and the error names only the variable", (variable) => {
    const { [variable]: _gone, ...rest } = S3;
    const refused = refusal({ ...valid, ...rest });
    expect(refused?.variable).toBe(variable);
    for (const value of Object.values(S3)) expect(refused?.shown).not.toContain(value);
  });

  it("shows neither key through JSON or inspect of the parsed settings", () => {
    const config = parseEnv({ ...valid, ...S3 });
    expect(config.storage.driver).toBe("s3");
    const shown = [JSON.stringify(config), inspect(config, { depth: 8 })].join("\n");
    expect(shown).not.toContain(String(S3.SHOUTORY_S3_ACCESS_KEY_ID));
    expect(shown).not.toContain(String(S3.SHOUTORY_S3_SECRET_ACCESS_KEY));
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

describe("database URLs per process role", () => {
  const onlyUrls = (role: string, names: string[]): Env => {
    const urls = Object.fromEntries(
      names.map((r) => [`SHOUTORY_DATABASE_URL_${r}`, valid[`SHOUTORY_DATABASE_URL_${r}`]]),
    );
    const rest = Object.fromEntries(
      Object.entries(valid).filter(([k]) => !k.startsWith("SHOUTORY_DATABASE_")),
    );
    return { ...rest, ...urls, SHOUTORY_ROLE: role } as Env;
  };
  it.each([
    ["api", ["APP", "AUTH"]],
    ["worker", ["WORKER"]],
    ["all", ["APP", "AUTH", "WORKER"]],
  ])("a %s process needs exactly its role URLs and holds no owner or readonly URL", (role, names) => {
    expect(Object.keys(parseEnv(onlyUrls(role, names)).databaseUrls).sort()).toEqual(
      names.map((n) => n.toLowerCase()).sort(),
    );
  });
  it.each([
    ["api", ["APP"], "SHOUTORY_DATABASE_URL_AUTH"],
    ["worker", [], "SHOUTORY_DATABASE_URL_WORKER"],
    ["all", ["APP", "AUTH"], "SHOUTORY_DATABASE_URL_WORKER"],
  ])("a %s process with a missing URL is refused and names it", (role, names, missing) => {
    expect(refusedVariable(onlyUrls(role, names))).toBe(missing);
  });
});

describe("SHOUTORY_EGRESS_ALLOW_CIDRS (the operator egress allowlist)", () => {
  const name = "SHOUTORY_EGRESS_ALLOW_CIDRS";

  it("is empty by default and parses a comma list of CIDRs", () => {
    expect(parseEnv(valid).egressAllowCidrs).toEqual([]);
    expect(parseEnv(withValue(name, "10.0.0.0/8, fd12::/16")).egressAllowCidrs).toHaveLength(2);
  });

  it.each(["10.0.0.0/8,not-a-cidr-canary", "169.254.0.0/16", "fe80::/10", "10.0.0.0/99", "168.63.129.16/32"])(
    "refuses %j at start-up, names the variable and never echoes the value",
    (value) => {
      const refused = refusal(withValue(name, value));
      expect(refused?.variable).toBe(name);
      expect(refused?.shown).not.toContain("not-a-cidr-canary");
      expect(refused?.shown).not.toContain(value);
    },
  );
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
