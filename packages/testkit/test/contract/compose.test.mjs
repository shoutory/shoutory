import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const compose = readFileSync(join(root, "docker/compose.yml"), "utf8");
const lines = compose.split("\n");

test("compose runs PostgreSQL only, by digest", () => {
  const services = lines.filter((line) => /^ {2}[a-z][\w-]*:\s*$/.test(line));
  assert.deepEqual(services, ["  postgres:"]);
  assert.match(compose, /^\s+image: postgres:18[\w.-]*@sha256:[0-9a-f]{64}$/m);
});

test("compose binds PostgreSQL to 127.0.0.1", () => {
  // Every item of a `ports:` list is a loopback binding; host networking and a wildcard address never appear.
  const start = lines.findIndex((line) => /^\s+ports:\s*$/.test(line));
  assert.ok(start >= 0, "no ports list was found");
  const ports = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+- /.test(line)) break;
    ports.push(line.trim());
  }
  assert.ok(ports.length >= 1, "no published port was found");
  for (const port of ports) assert.match(port, /^- "127\.0\.0\.1:\d+:\d+"$/);
  assert.doesNotMatch(compose, /network_mode/);
  assert.doesNotMatch(compose, /0\.0\.0\.0/);
});

test("compose takes every credential from the environment and refuses an unset one", () => {
  const credentials = lines.filter((line) => /^\s+[A-Z_]*PASSWORD[A-Z_]*:/.test(line));
  assert.ok(credentials.length >= 6, "the superuser and five role passwords must be listed");
  for (const line of credentials) assert.match(line.trim(), /^[A-Z_]+: \$\{[A-Z_]+:\?[^}]+\}$/);
});
