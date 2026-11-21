import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const compose = readFileSync(join(root, "docker/compose.yml"), "utf8");
const { services } = parse(compose);
const IMAGE = "${SHOUTORY_IMAGE:-ghcr.io/shoutory/shoutory:stable}";
// Everything a service sets that is a credential, a key or a connection string comes from the environment.
const SENSITIVE = /PASSWORD|SECRET|PEPPER|KEK|_URL/;

test("compose runs PostgreSQL by digest, the one-shot migrate and the app only: no Redis, no MinIO", () => {
  assert.deepEqual(Object.keys(services).sort(), ["migrate", "postgres", "shoutory"]);
  assert.match(services.postgres.image, /^postgres:18[\w.-]*@sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(compose, /redis|minio/i);
});

test("every healthcheck command is a list of strings, so compose accepts the file", () => {
  for (const [name, service] of Object.entries(services)) {
    for (const part of service.healthcheck?.test ?? []) assert.equal(typeof part, "string", name);
  }
});

test("the database healthcheck connects over TCP, because the init-time server listens on its socket only", () => {
  assert.match(services.postgres.healthcheck.test.join(" "), /pg_isready .*-h 127\.0\.0\.1/);
});

test("the app starts only after migrate completed, and migrate runs once with the owner role alone", () => {
  assert.equal(services.shoutory.depends_on.migrate.condition, "service_completed_successfully");
  assert.equal(services.migrate.restart, "no");
  assert.deepEqual(services.migrate.command, ["migrate"]);
  const urls = Object.keys(services.migrate.environment).filter((key) =>
    key.startsWith("SHOUTORY_DATABASE_URL_"),
  );
  assert.deepEqual(urls, ["SHOUTORY_DATABASE_URL_OWNER"]);
});

test("migrate and the app are one image, which compose can also build", () => {
  for (const name of ["migrate", "shoutory"]) {
    assert.equal(services[name].image, IMAGE, name);
    assert.deepEqual(services[name].build, { context: "..", dockerfile: "docker/Dockerfile" }, name);
  }
});

test("the app has a read-only root, a tmpfs /tmp, a /data volume and the all role by default", () => {
  const app = services.shoutory;
  assert.equal(app.read_only, true);
  assert.ok(app.tmpfs.includes("/tmp"), "no tmpfs on /tmp");
  assert.ok(
    app.volumes.some((volume) => volume.split(":")[1] === "/data"),
    "no /data volume",
  );
  assert.equal(app.environment.SHOUTORY_ROLE, "${SHOUTORY_ROLE:-all}");
});

test("compose binds every published port to 127.0.0.1 and never uses host networking", () => {
  const ports = Object.values(services).flatMap((service) => service.ports ?? []);
  assert.ok(ports.length >= 1, "no published port was found");
  for (const port of ports) assert.match(port, /^127\.0\.0\.1:\d+:\d+$/);
  assert.doesNotMatch(compose, /network_mode/);
  assert.doesNotMatch(compose, /0\.0\.0\.0/);
});

test("compose takes every credential from the environment and refuses an unset one", () => {
  const entries = Object.values(services).flatMap((service) => Object.entries(service.environment ?? {}));
  const sensitive = entries.filter(([key]) => SENSITIVE.test(key));
  assert.ok(sensitive.length >= 6, "the superuser and the role passwords must be listed");
  // The optional S3 settings are passed through unset (no value): the app refuses an empty one (R504).
  const required = sensitive.filter(([key]) => !key.startsWith("SHOUTORY_S3_"));
  for (const [key, value] of required) assert.match(String(value), /^\$\{[A-Z0-9_]+:\?[^}]+\}$/, key);
});

test("the app service receives no owner or readonly database URL and no database password", () => {
  const keys = Object.keys(services.shoutory.environment);
  assert.deepEqual(
    keys.filter((key) => /DATABASE_URL_(OWNER|READONLY)|DATABASE_PASSWORD_/.test(key)),
    [],
  );
});

test("every README operator variable is in a compose service environment", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const table = readme.slice(readme.indexOf("## Configuration"));
  // The image sets these; the published port fixes the listen port and address, so compose does not pass them (R504).
  const exempt = new Set([
    "SHOUTORY_RELEASE_CHANNEL",
    "SHOUTORY_WEB_ROOT",
    "SHOUTORY_DATA_DIR",
    "SHOUTORY_PORT",
    "SHOUTORY_HOST",
  ]);
  const present = new Set(Object.values(services).flatMap((s) => Object.keys(s.environment ?? {})));
  const missing = [];
  for (const [, cell] of table.matchAll(/^\| (`[^|]+?`)\s+\|/gm)) {
    const names = [...cell.matchAll(/`(SHOUTORY_[A-Z0-9_<>]+)`/g)].map((m) => m[1]);
    const prefix = names[0]?.replace(/[A-Z]+$/, "") ?? "";
    for (const m of cell.matchAll(/`_([A-Z]+)`/g)) names.push(`${prefix}${m[1]}`);
    for (const name of names) {
      const found = name === "SHOUTORY_KEK_<ID>" ? present.has("SHOUTORY_KEK_K1") : present.has(name);
      if (!found && !exempt.has(name)) missing.push(name);
    }
  }
  assert.deepEqual(missing, []);
});
