import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { STEPS } from "../../../../scripts/verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OVERRIDE = "e2e/support/compose.e2e.yml";

function filesUnder(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("the e2e override pins the mail catcher by digest, publishes only to 127.0.0.1 and holds no credential literal", () => {
  assert.ok(existsSync(join(root, OVERRIDE)), `there is no ${OVERRIDE}`);
  const text = readFileSync(join(root, OVERRIDE), "utf8");
  const { services } = parse(text);
  assert.match(services.mail.image, /^axllent\/mailpit:v1\.33\.0@sha256:[0-9a-f]{64}$/);
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes(services.mail.image));
  assert.match(lines[at - 1], /^\s*# .*\b20\d\d-\d\d-\d\d\b/, "no date above the digest");
  assert.ok(services.mail.environment.MP_DISABLE_VERSION_CHECK, "the update check is not switched off");
  for (const service of Object.values(services)) {
    for (const port of service.ports ?? []) assert.match(String(port), /^127\.0\.0\.1:/);
  }
  const literal = /(password|secret|pepper|kek|token)\w*["']?\s*[:=]\s*["'][A-Za-z0-9+/=_-]{8,}["']/i;
  for (const file of filesUnder("e2e").filter((name) => /\.(ts|yml)$/.test(name))) {
    assert.doesNotMatch(
      readFileSync(join(root, file), "utf8"),
      literal,
      `${file} holds a credential literal`,
    );
  }
});

test("the DNS sidecar is pinned by digest, logs every query, forwards none, and only the app uses it", () => {
  const text = readFileSync(join(root, OVERRIDE), "utf8");
  const { services, configs } = parse(text);
  assert.match(services.dns?.image ?? "", /^coredns\/coredns:1\.15\.0@sha256:[0-9a-f]{64}$/);
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes(services.dns.image));
  assert.match(lines[at - 1], /^\s*# .*\b20\d\d-\d\d-\d\d\b/, "no date above the digest");
  assert.equal(services.dns.ports, undefined, "the sidecar publishes no port");
  const corefile = configs[services.dns.configs[0].source].content;
  assert.match(corefile, /^\s*log\s*$/m, "the Corefile does not log queries");
  assert.doesNotMatch(corefile, /forward|proxy|\bfile\b|\bhosts\b/, "the Corefile answers from somewhere");
  assert.deepEqual(services.shoutory.dns, ["${SHOUTORY_E2E_DNS_IP:-127.0.0.1}"]);
  const withDns = (file) =>
    Object.entries(parse(readFileSync(join(root, file), "utf8")).services)
      .filter(([, service]) => service.dns !== undefined)
      .map(([name]) => name);
  assert.deepEqual(withDns(OVERRIDE), ["shoutory"], "only the app is pointed at the sidecar");
  assert.deepEqual(withDns("docker/compose.yml"), [], "the self-host file sets no resolver");
});

test("the e2e and image-smoke steps are Docker steps, so a missing Docker is named before Playwright starts", () => {
  for (const name of ["e2e", "image-smoke"]) {
    assert.equal(STEPS.find((step) => step.name === name).docker, true, name);
  }
});
