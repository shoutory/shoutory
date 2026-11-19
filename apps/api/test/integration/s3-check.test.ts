import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";
import { createBucket, S3_ACCESS_KEY, S3_SECRET_KEY, s3Env } from "../support/s3.js";

// The storage check on the S3 driver against the simulator. The bucket, the access key and the secret key are
// canaries: no answer, stream or log line may carry one, whether the check passes or the SDK's own error names them.
const BUCKET = "canary-bucket-1";
const MISSING_BUCKET = "canary-missing-bucket-1";
const WRONG_SECRET = "wrong-key-for-the-canary-test";
const spellings = (v: string) => [
  v,
  encodeURIComponent(v),
  Buffer.from(v).toString("hex"),
  Buffer.from(v).toString("base64"),
  JSON.stringify(v).slice(1, -1),
];
const expectNoCanary = (text: string) => {
  for (const value of [BUCKET, MISSING_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, WRONG_SECRET]) {
    for (const form of spellings(value)) expect(text).not.toContain(form);
  }
};

beforeAll(() => createBucket(BUCKET));

const SCENARIOS: [string, () => Record<string, string>, number, string | null][] = [
  ["a working bucket", () => s3Env(BUCKET), 0, null],
  ["a bucket that does not exist", () => s3Env(MISSING_BUCKET), 1, "write_failed"],
  [
    "a wrong secret key",
    () => s3Env(BUCKET, { SHOUTORY_S3_SECRET_ACCESS_KEY: WRONG_SECRET }),
    1,
    "write_failed",
  ],
];

describe("shoutory storage check with the s3 driver", () => {
  it.each(SCENARIOS)(
    "with %s the output is a class and carries no bucket or key",
    async (_name, env, exit, failure) => {
      const out: string[] = [];
      const err: string[] = [];
      const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
      expect(await run(["storage", "check"], env(), io)).toBe(exit);
      expect(JSON.parse(out.join(""))).toMatchObject({ driver: "s3", failure });
      expectNoCanary([...out, ...err].join("\n"));
    },
  );
});
