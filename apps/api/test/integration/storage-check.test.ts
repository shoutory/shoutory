import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { signedUser } from "../support/tenancy.js";
import { cookieOf, PASSWORD, startFixture } from "./auth/harness.js";

// The operator storage check over a real folder. The data folder's name is a canary: neither the answer nor any
// stream may carry the folder, whether the check passes or fails.
const CANARY = "storage-canary-dir a+b=c";
const spellings = (v: string) => [
  v,
  encodeURIComponent(v),
  Buffer.from(v).toString("hex"),
  Buffer.from(v).toString("base64"),
  JSON.stringify(v).slice(1, -1),
];

let base: string;
let present: string;
let missing: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "shoutory-storage-check-"));
  present = join(base, CANARY);
  missing = join(base, `${CANARY} missing`);
  await mkdir(present);
});
afterAll(() => rm(base, { recursive: true, force: true }));

const expectNoPath = (text: string) => {
  for (const form of [...spellings(CANARY), ...spellings(base)]) expect(text).not.toContain(form);
};

describe("admin storage check route: the answer and the log carry no path", () => {
  it("with a data folder that is not mounted", async () => {
    const fx = await startFixture({ storage: createFsDriver(missing) });
    try {
      const first = await signedUser(fx, "storage-admin");
      const email = (
        await fx.admin((client) => client.query('SELECT email FROM auth."user" WHERE id = $1', [first.id]))
      ).rows[0].email;
      const cookie = cookieOf(
        await fx.request("/api/auth/sign-in/email", { body: { email, password: PASSWORD } }),
      );
      const answer = await fx.request("/api/v1/admin/storage/check", {
        method: "POST",
        headers: { cookie },
      });
      const text = await answer.text();
      expect(answer.status).toBe(200);
      expect(JSON.parse(text).data).toMatchObject({ driver: "fs", failure: "write_failed" });
      expectNoPath(`${text}\n${fx.logged.join("\n")}`);
    } finally {
      await fx.close();
    }
  });
});

describe("shoutory storage check", () => {
  it("reports writable, readable and free space, exits 0 and leaves no probe object behind", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
    expect(await run(["storage", "check"], { SHOUTORY_DATA_DIR: present }, io)).toBe(0);
    expect(err).toEqual([]);
    const answer = JSON.parse(out.join(""));
    expect(answer).toMatchObject({ driver: "fs", writable: true, readable: true, failure: null });
    expect(answer.free_bytes).toBeGreaterThan(0);
    expect(await readdir(join(present, ".shoutory-check"))).toEqual([]);
    expectNoPath(out.join("\n"));
  });

  it("reports a missing data folder as write_failed with exit 1, without the folder's path", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
    expect(await run(["storage", "check"], { SHOUTORY_DATA_DIR: missing }, io)).toBe(1);
    expect(JSON.parse(out.join(""))).toEqual({
      driver: "fs",
      writable: false,
      readable: false,
      free_bytes: null,
      failure: "write_failed",
      warnings: [],
    });
    expectNoPath([...out, ...err].join("\n"));
  });

  it("refuses a relative data folder by naming the variable only", async () => {
    const err: string[] = [];
    const io = { stdout: () => undefined, stderr: (line: string) => err.push(line) };
    expect(await run(["storage", "check"], { SHOUTORY_DATA_DIR: "relative/data" }, io)).toBe(1);
    expect(err.join("")).toContain("SHOUTORY_DATA_DIR");
    expect(err.join("")).not.toContain("relative/data");
  });
});
