import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (file) => readFileSync(join(root, file), "utf8");
const json = (file) => JSON.parse(read(file));
const workflow = (name) => parse(read(`.github/workflows/${name}`));
const steps = (job) => job.steps ?? [];
const runs = (job) => steps(job).map((step) => step.run ?? "");
const usesOf = (job, action) => steps(job).find((step) => (step.uses ?? "").startsWith(`${action}@`));
const list = (value) => [value ?? []].flat();

// The pins of the version record: every action by commit SHA.
const PINS = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1",
  "googleapis/release-please-action": "45996ed1f6d02564a971a2fa1b5860e934307cf7",
  "actions/upload-artifact": "cf430e030ddbb5b0abf93d22962f4752f3646cd9",
  "actions/download-artifact": "9000827ccba6bdab643e8b6fd33ac0654aef8333",
  "docker/setup-buildx-action": "f87e5991a6d7451dcb8d9637bfbc97413f497069",
  "docker/login-action": "81c6f93d4bc991e510b342a00b419b3bb4efc5c6",
  "docker/build-push-action": "c3c9e263c25d99ce0380d002d59b67737d91b0dc",
  "sigstore/cosign-installer": "6f9f17788090df1f26f669e9d70d6ae9567deba6",
  "anchore/sbom-action": "66cbf4bc1f1c0d2edc94016e65bc221b6bb0ad6c",
  "actions/attest-build-provenance": "4d101475d8b20a2381f78447822ac1eab6504dd8",
};

test("the release tool runs from main and beta or by hand, picks its config pair by ref and tags without a component", () => {
  const release = workflow("release.yml");
  assert.deepEqual(release.on, { push: { branches: ["main", "beta"] }, workflow_dispatch: null });
  const action = usesOf(release.jobs["release-please"], "googleapis/release-please-action");
  for (const input of ["config-file", "manifest-file"]) {
    assert.match(String(action.with[input]), /github\.ref_name/, `${input} is not chosen by the ref`);
  }
  const config = json("release-please-config.json");
  assert.equal(config["release-type"], "node");
  assert.equal(config["include-component-in-tag"], false);
  assert.deepEqual(json(".release-please-manifest.json"), { ".": json("package.json").version });
});

test("the beta config sets prerelease and the main config does not, and the beta manifest exists", () => {
  const beta = json("release-please-config.beta.json");
  assert.equal(beta.prerelease, true);
  assert.equal(beta["prerelease-type"], "beta");
  assert.equal(json("release-please-config.json").prerelease, undefined);
  assert.equal(typeof json(".release-please-manifest.beta.json")["."], "string");
});

test("the release-please job runs only on main or beta and starts this workflow on the tag it made", () => {
  const job = workflow("release.yml").jobs["release-please"];
  assert.equal(job.permissions.actions, "write");
  assert.ok("release_created" in job.outputs && "tag_name" in job.outputs, "no outputs");
  // Only a push to main or beta (or a manual run on one of them) opens release pull requests; a tag run, or a manual
  // run on any other ref, does not.
  assert.match(job.if ?? "", /github\.ref_name == 'main'/, "main is not named");
  assert.match(job.if, /github\.ref_name == 'beta'/, "beta is not named");
  assert.doesNotMatch(job.if, /!=|!startsWith/, "the job is kept off refs by exclusion");
  const last = steps(job).at(-1);
  assert.match(last.if ?? "", /release_created/);
  assert.match(last.run ?? "", /gh workflow run release\.yml --ref /);
  assert.doesNotMatch(last.run, /\$\{\{/, "the tag is in the script text");
  assert.match(JSON.stringify(last.env ?? {}), /tag_name/, "the tag does not arrive through env");
});

test("only the image job holds id-token: it needs build, runs in release and has exactly four permissions", () => {
  const { jobs } = workflow("release.yml");
  for (const [id, job] of Object.entries(jobs)) {
    assert.equal(job.permissions?.["id-token"] === "write", id === "image", `${id}: id-token`);
  }
  const image = jobs.image;
  assert.equal(image.environment, "release");
  assert.deepEqual(list(image.needs), ["build"]);
  assert.deepEqual(image.permissions, {
    contents: "read",
    packages: "write",
    "id-token": "write",
    attestations: "write",
  });
});

test("the build job pushes each architecture by digest on its native runner, with no emulation and no id-token", () => {
  const build = workflow("release.yml").jobs.build;
  assert.equal(build["runs-on"], "${{ matrix.runner }}");
  assert.deepEqual([...build.strategy.matrix.runner].sort(), ["ubuntu-24.04", "ubuntu-24.04-arm"]);
  assert.deepEqual([...build.strategy.matrix.target].sort(), ["debug", "nonroot"]);
  assert.deepEqual(build.permissions, { contents: "read", packages: "write" });
  const push = usesOf(build, "docker/build-push-action");
  assert.match(String(push.with.outputs), /push-by-digest=true/);
  assert.equal(push.with.provenance, false);
  assert.equal(push.with.sbom, false);
  assert.ok(!steps(build).some((step) => (step.uses ?? "").includes("setup-qemu")), "QEMU in the build");
});

test("every action in release.yml and nightly.yml is the pinned commit; cosign and syft come in as inputs", () => {
  for (const name of ["release.yml", "nightly.yml"]) {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of steps(job).filter((one) => one.uses)) {
        const [action, ref] = step.uses.split("@");
        assert.equal(ref, PINS[action], `${name}: ${step.uses}`);
      }
    }
  }
  const image = workflow("release.yml").jobs.image;
  assert.equal(usesOf(image, "sigstore/cosign-installer").with["cosign-release"], "v3.1.4");
  assert.equal(usesOf(image, "anchore/sbom-action").with["syft-version"], "v1.56.0");
  const text = read(".github/workflows/release.yml");
  for (const unpinned of ["attest-sbom", "metadata-action", "setup-qemu"]) {
    assert.ok(!text.includes(unpinned), unpinned);
  }
});

test("the upgrade-note script runs before any build step and gets the tag through env, never inline", () => {
  const build = workflow("release.yml").jobs.build;
  const at = steps(build).findIndex((step) => (step.run ?? "").includes("upgrade-note.mjs"));
  assert.ok(at >= 0, "the build job never runs the upgrade-note script");
  const first = steps(build).findIndex((step) => (step.uses ?? "").startsWith("docker/build-push-action@"));
  assert.ok(at < first, "the upgrade-note script must run before the first build step");
  assert.doesNotMatch(steps(build)[at].run, /\$\{\{/);
  assert.match(JSON.stringify(steps(build)[at].env ?? {}), /github\.ref_name/);
});

test("the sign step addresses the digest, never a tag, and a cosign verify step follows with the release identity and issuer", () => {
  const image = steps(workflow("release.yml").jobs.image);
  const sign = image.findIndex((step) => /cosign sign\b/.test(step.run ?? ""));
  assert.ok(sign >= 0, "no cosign sign step");
  assert.match(image[sign].run, /cosign sign[^\n]*@"?\$\{?DIGEST/);
  assert.doesNotMatch(image[sign].run, /cosign sign[^\n]*:"?\$\{?TAG/);
  const verify = image.findIndex((step, at) => at > sign && /cosign verify\b/.test(step.run ?? ""));
  assert.ok(verify > sign, "no cosign verify step after the sign step");
  const text = image[verify].run;
  assert.match(text, /--certificate-identity[^\n]*release\.yml/);
  assert.match(text, /--certificate-oidc-issuer[ =]"?https:\/\/token\.actions\.githubusercontent\.com/);
});

test("the merge step stops on any failure, on no digests or no tags, and writes only a checked digest", () => {
  const merge = steps(workflow("release.yml").jobs.image).find((step) => step.id === "merge");
  assert.ok(merge, "no merge step");
  const text = merge.run;
  assert.match(text, /^set -euo pipefail$/m, "errexit and pipefail do not hold");
  assert.doesNotMatch(
    text,
    /\$\(\s*merge\b|`\s*merge\b/,
    "the merge runs in a command substitution, where a failure is lost",
  );
  assert.match(text, /no digests/, "an empty digests folder does not fail");
  assert.match(text, /no tags/, "an empty tag list does not fail");
  const check = text.indexOf("^sha256:[0-9a-f]{64}$");
  assert.ok(check >= 0, "a digest is not checked against the format");
  assert.ok(check < text.indexOf("GITHUB_OUTPUT"), "a digest is written before it is checked");
});

test("provenance is attested without a storage record and the SBOM is a cosign attestation of the syft output", () => {
  const image = workflow("release.yml").jobs.image;
  const provenance = usesOf(image, "actions/attest-build-provenance");
  assert.equal(provenance.with["create-storage-record"], false);
  assert.equal(provenance.with["push-to-registry"], true);
  assert.equal(usesOf(image, "anchore/sbom-action").with["upload-release-assets"], false);
  assert.ok(
    runs(image).some((text) => /cosign attest\b[^\n]*--type spdxjson/.test(text)),
    "no SBOM attestation",
  );
});

test("nightly.yml has no id-token and no tag trigger, publishes no package, signs nothing and runs only from main", () => {
  const nightly = workflow("nightly.yml");
  assert.deepEqual(Object.keys(nightly.on).sort(), ["schedule", "workflow_dispatch"]);
  for (const job of Object.values(nightly.jobs)) {
    assert.equal(job.permissions?.["id-token"], undefined);
    assert.match(job.if ?? "", /refs\/heads\/main/);
    assert.deepEqual(job.permissions, { contents: "read", packages: "write" });
  }
  const text = read(".github/workflows/nightly.yml");
  assert.doesNotMatch(text, /npm publish|pnpm publish|cosign/);
});

test("the build job runs only on a refs/tags/v ref, so a push to main or beta pushes no image", () => {
  const { jobs } = workflow("release.yml");
  for (const id of ["build", "image"]) {
    const condition = jobs[id].if ?? "";
    assert.match(condition, /startsWith\(github\.ref, 'refs\/tags\/v'\)/, `${id}: not gated on a tag`);
    assert.doesNotMatch(condition, /\|\||always\(|cancelled\(|failure\(/, `${id}: the gate can be bypassed`);
  }
  assert.equal(jobs.build.permissions.packages, "write", "the job that pushes is the job that is gated");
});

test("nightly takes its tags from release-tags.mjs with the run date and pushes nothing else", () => {
  const job = Object.values(workflow("nightly.yml").jobs)[0];
  const tagging = steps(job).find((step) => /release-tags\.mjs/.test(step.run ?? ""));
  assert.ok(tagging, "no step runs the tag script");
  assert.match(tagging.run, /release-tags\.mjs "\$\(date -u \+%F\)"/, "the date is not the run date");
  assert.match(tagging.run, />> "\$GITHUB_OUTPUT"/);
  const push = usesOf(job, "docker/build-push-action");
  assert.match(String(push.with.tags), /steps\.[\w-]+\.outputs\.tags/, "the tags are not the script's");
  assert.doesNotMatch(
    JSON.stringify(push.with),
    /stable|beta|latest|v?\d+\.\d+\.\d+/,
    "a version tag is pushed",
  );
  assert.match(JSON.stringify(push.with.build_args ?? push.with["build-args"] ?? ""), /nightly/);
});

test("no run step in release.yml or nightly.yml holds an expression", () => {
  for (const name of ["release.yml", "nightly.yml"]) {
    for (const [id, job] of Object.entries(workflow(name).jobs)) {
      for (const text of runs(job)) assert.doesNotMatch(text, /\$\{\{/, `${name}: ${id}`);
    }
  }
});
