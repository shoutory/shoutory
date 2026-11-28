import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { ALL_HOSTS } = await import(pathToFileURL(join(root, "e2e/fixtures/simulators-plan.ts")).href);
const { services, networks } = parse(readFileSync(join(root, "e2e/support/compose.e2e.yml"), "utf8"));

test("the simulators container answers to every host the adapters call, and to no other name", () => {
  const aliases = services.simulators?.networks?.default?.aliases ?? [];
  assert.deepEqual([...aliases].sort(), [...ALL_HOSTS].sort());
});

test("the e2e network is pinned to the subnet the app's egress allowlist names, and the allowlist names nothing else", () => {
  const [pinned, ...others] = networks.default.ipam.config;
  assert.equal(others.length, 0);
  assert.match(pinned.subnet, /^172\.(1[6-9]|2\d|3[01])\.\d+\.0\/24$/);
  assert.equal(services.shoutory.environment.SHOUTORY_EGRESS_ALLOW_CIDRS, pinned.subnet);
});

test("the app trusts only the test CA's certificate file, and the simulators container is the only one that sees the server key", () => {
  const mounts = (service, variable) =>
    (service.volumes ?? []).filter(({ source }) => source.includes(variable)).map(({ target }) => target);
  assert.equal(services.shoutory.environment.NODE_EXTRA_CA_CERTS, "/e2e-ca/ca.pem");
  assert.deepEqual(mounts(services.shoutory, "SHOUTORY_E2E_CA_DIR"), ["/e2e-ca"]);
  assert.deepEqual(mounts(services.shoutory, "SHOUTORY_E2E_SIM_DIR"), []);
  assert.deepEqual(mounts(services.simulators, "SHOUTORY_E2E_SIM_DIR"), ["/sim"]);
  assert.deepEqual(mounts(services.simulators, "SHOUTORY_E2E_CA_DIR"), []);
});
