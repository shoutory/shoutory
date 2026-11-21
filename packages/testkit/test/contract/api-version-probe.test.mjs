import { strict as assert } from "node:assert";
import { test } from "node:test";
import { probeApiVersions } from "../../../../scripts/probe-api-versions.mjs";

const manifest = (overrides = {}) => ({
  id: "fixture",
  apiVersions: [{ version: "v1", docsUrl: "https://docs.fixture.example/api/v1", ...overrides }],
});
const OPTIONS = { timeoutMs: 200, maxBytes: 1024 };
const answer =
  (status, body = "ok") =>
  async () =>
    new Response(body, { status });

test("the probe passes on an empty registry", async () => {
  const result = await probeApiVersions([], { ...OPTIONS, fetch: answer(500) });
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("the probe passes when the version URL answers", async () => {
  const result = await probeApiVersions([manifest()], { ...OPTIONS, fetch: answer(200) });
  assert.equal(result.ok, true);
});

test("the probe fails and names the provider and URL when the version URL is unreachable", async () => {
  const fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const result = await probeApiVersions([manifest()], { ...OPTIONS, fetch });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].providerId, "fixture");
  assert.equal(result.problems[0].url, "https://docs.fixture.example/api/v1");
});

test("the probe fails when the version URL answers with an error status", async () => {
  const result = await probeApiVersions([manifest()], { ...OPTIONS, fetch: answer(404) });
  assert.equal(result.ok, false);
});

// The two bounds: a request that never answers fails at the timeout, an endless body is cut at the size bound.
const BOUNDS = [
  [
    "the probe fails when the request outlives its timeout",
    false,
    () => ({
      fetch: (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      pulled: () => 0,
    }),
  ],
  [
    "the probe stops reading a response at the size bound",
    true,
    () => {
      let count = 0;
      const body = new ReadableStream({
        pull(controller) {
          count += 1;
          controller.enqueue(new Uint8Array(512));
        },
      });
      return { fetch: async () => new Response(body), pulled: () => count };
    },
  ],
];

for (const [title, ok, build] of BOUNDS) {
  test(title, async () => {
    const { fetch, pulled } = build();
    const result = await probeApiVersions([manifest()], { timeoutMs: 50, maxBytes: 1024, fetch });
    assert.equal(result.ok, ok);
    assert.ok(pulled() < 20, `pulled ${pulled()} chunks of an endless body`);
  });
}
