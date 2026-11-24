import { strict as assert } from "node:assert";
import { test } from "node:test";

const load = async () => (await import("../../scripts/release-tags.mjs")).imageTags;

const CASES = [
  [
    "a stable tag gives its version, minor, major and stable",
    "v1.2.3",
    { channel: "stable", tags: ["1.2.3", "1.2", "1", "stable"], debugTags: ["1.2.3-debug"] },
  ],
  [
    "a 0.x stable tag skips the major tag, which would move with every minor",
    "v0.5.1",
    { channel: "stable", tags: ["0.5.1", "0.5", "stable"], debugTags: ["0.5.1-debug"] },
  ],
  [
    "a beta tag gives its exact tag and beta, never stable or a shorter version",
    "v1.3.0-beta.2",
    {
      channel: "beta",
      tags: ["1.3.0-beta.2", "beta"],
      debugTags: ["1.3.0-beta.2-debug", "beta-debug"],
    },
  ],
  [
    "a nightly date gives nightly and the dated tag, no debug image and no stable",
    "2026-11-21",
    { channel: "nightly", tags: ["nightly", "nightly-20261121"], debugTags: [] },
  ],
];

for (const [title, input, expected] of CASES) {
  test(`release tags: ${title}`, async () => {
    assert.deepEqual((await load())(input), expected);
  });
}

for (const input of [
  "next",
  "v1.2",
  "1.2.3.4",
  "2026-13-45",
  "",
  "v1.0.0-rc.1",
  "v01.2.3",
  "v00.1.0",
  "v1.3.0-beta.01",
]) {
  test(`release tags: ${JSON.stringify(input)} is not a releasable tag or a date`, async () => {
    const tags = await load();
    assert.throws(() => tags(input));
  });
}

test("release tags: no beta or nightly gives stable or a version that a stable release moves", async () => {
  const tags = await load();
  for (const input of ["v2.0.0-beta.10", "v0.9.0-beta.0", "2027-01-01"]) {
    const { tags: given, debugTags } = tags(input);
    assert.ok(![...given, ...debugTags].some((tag) => /^stable|^\d+(\.\d+)?$/.test(tag)), input);
  }
});
