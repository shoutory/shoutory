import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageDriver } from "@shoutory/core/storage";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { animatedGif, declaredPng, png } from "../support/images.js";
import { signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture, WEB } from "./auth/harness.js";

type User = { id: string; cookie: string };
const PATH = "/api/v1/me/avatar";
const MAX = 10 * 1024 * 1024;
let fx: Fixture;
let dir: string;
let scratch: string;
let storage: StorageDriver;
let alice: User;
let bob: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-avatar-"));
  scratch = await mkdtemp(join(tmpdir(), "shoutory-avatar-scratch-"));
  storage = createFsDriver(dir);
  fx = await startFixture({ storage, scratchDir: scratch });
  alice = await signedUser(fx, "avatar-alice");
  bob = await signedUser(fx, "avatar-bob");
});
afterAll(async () => {
  await fx.close();
  await rm(dir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

const keyOf = (user: User) => `users/${user.id}/avatar.webp`;
const ip = { incoming: { socket: { remoteAddress: "192.0.2.78" } } };

interface Sent {
  who?: User | null;
  csrf?: boolean;
  headers?: Record<string, string | null>;
  stream?: ReadableStream<Uint8Array>;
}
function call(method: "GET" | "PUT" | "DELETE", body?: Buffer, sent: Sent = {}) {
  const who = sent.who === undefined ? alice : sent.who;
  const headers: Record<string, string> = {
    ...(sent.csrf === false ? {} : WEB),
    ...(who ? { cookie: who.cookie } : {}),
    ...(body ? { "content-type": "application/octet-stream", "content-length": String(body.length) } : {}),
  };
  for (const [name, value] of Object.entries(sent.headers ?? {})) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  const payload = sent.stream
    ? { body: sent.stream, duplex: "half" as const }
    : body
      ? { body: new Uint8Array(body) }
      : {};
  return fx.app.request(PATH, { method, headers, ...payload }, ip);
}
const codeOf = async (answer: Response) => ((await answer.json()) as { error: { code: string } }).error.code;
const avatarAtOf = (user: User) =>
  fx.admin(
    async (client) =>
      (await client.query("SELECT avatar_at FROM app.user_profiles WHERE user_id = $1", [user.id])).rows[0]
        ?.avatar_at ?? null,
  );
async function sessionAvatarOf(user: User): Promise<string | null> {
  const answer = await fx.app.request("/api/auth/get-session", { headers: { cookie: user.cookie } }, ip);
  return ((await answer.json()) as { data: { user: { avatarAt: string | null } } }).data.user.avatarAt;
}

describe("who may reach a profile picture (floor)", () => {
  it.each(["GET", "PUT", "DELETE"] as const)("%s without a session is 401", async (method) => {
    const answer = await call(method, method === "PUT" ? await png() : undefined, { who: null });
    expect(answer.status).toBe(401);
  });

  it.each(["PUT", "DELETE"] as const)(
    "%s without the web client's CSRF headers is 403 and changes nothing",
    async (method) => {
      const answer = await call(method, method === "PUT" ? await png() : undefined, { csrf: false });
      expect(answer.status).toBe(403);
      expect(await storage.head(keyOf(alice))).toBeNull();
    },
  );

  it("an API key is not a session: a Bearer header is 401 even beside a valid session cookie", async () => {
    const answer = await call("PUT", await png(), { headers: { authorization: "Bearer shy_avatar-key-1" } });
    expect(answer.status).toBe(401);
    expect(await storage.head(keyOf(alice))).toBeNull();
  });

  it("each person reaches only their own picture: another session never reads, replaces or removes it", async () => {
    expect((await call("PUT", await png(20, 20))).status).toBe(200);
    const mine = await storage.head(keyOf(alice));
    expect((await call("GET", undefined, { who: bob })).status).toBe(404);
    expect((await call("DELETE", undefined, { who: bob })).status).toBe(204);
    expect((await call("PUT", await png(30, 30), { who: bob })).status).toBe(200);
    expect(await storage.head(keyOf(alice))).toEqual(mine);
    expect(await avatarAtOf(alice)).not.toBeNull();
    expect(await storage.head(keyOf(bob))).not.toBeNull();
    expect((await call("DELETE")).status).toBe(204);
    expect((await call("DELETE", undefined, { who: bob })).status).toBe(204);
  });
});

describe("what a profile picture upload accepts (floor)", () => {
  it("a body without a declared length is refused before any decode", async () => {
    const bytes = await png();
    const stream = new Blob([new Uint8Array(bytes)]).stream();
    const answer = await call("PUT", bytes, { stream, headers: { "content-length": null } });
    expect(answer.status).toBe(400);
    expect(await storage.head(keyOf(alice))).toBeNull();
  });

  it("a body declared over 10 MiB is 413 before any read", async () => {
    const stream = new ReadableStream<Uint8Array>({ start: () => undefined });
    const answer = await call("PUT", await png(), { stream, headers: { "content-length": String(MAX + 1) } });
    expect(answer.status).toBe(413);
    expect(await storage.head(keyOf(alice))).toBeNull();
  });

  it.each<[string, () => Promise<Buffer> | Buffer, string]>([
    ["a GIF, which the decoder reads but a profile picture refuses", () => animatedGif(), "unsupported_type"],
    [
      "an SVG named as a PNG",
      () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      "unsupported_type",
    ],
    [
      "HTML sent as an image",
      () => Buffer.from("<!doctype html><html><body>avatar-html-1</body></html>"),
      "unsupported_type",
    ],
    ["a PNG whose header declares 20000 x 20000 pixels", () => declaredPng(20_000, 20_000), "pixel_limit"],
  ])("%s is 422 and stores nothing", async (_what, body, reason) => {
    const answer = await call("PUT", await body(), { headers: { "content-type": "image/png" } });
    expect(answer.status).toBe(422);
    const error = ((await answer.json()) as { error: { code: string; details?: { reason?: string } } }).error;
    expect([error.code, error.details?.reason]).toEqual(["unprocessable_content", reason]);
    expect(await storage.head(keyOf(alice))).toBeNull();
    expect(await avatarAtOf(alice)).toBeNull();
    expect(await readdir(scratch)).toEqual([]);
  });
});

describe("a profile picture", () => {
  it("is stored re-encoded under the user's own key, served private and not sniffed, named in the session, and removed in one step", async () => {
    expect(await sessionAvatarOf(alice)).toBeNull();
    const saved = await call("PUT", await png(640, 480));
    expect(saved.status).toBe(200);
    const at = ((await saved.json()) as { data: { avatar_at: string } }).data.avatar_at;
    expect(await sessionAvatarOf(alice)).toBe(at);
    const read = await call("GET");
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/webp");
    expect(read.headers.get("cache-control")).toBe("private, no-cache");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await sharp(Buffer.from(await read.arrayBuffer())).metadata()).format).toBe("webp");
    expect(await readdir(scratch)).toEqual([]);
    const etag = read.headers.get("etag") ?? "";
    expect((await call("GET", undefined, { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await call("DELETE")).status).toBe(204);
    expect(await storage.head(keyOf(alice))).toBeNull();
    expect(await sessionAvatarOf(alice)).toBeNull();
    expect((await call("GET")).status).toBe(404);
  });

  it("removing a picture that is not there is still 204", async () => {
    expect((await call("DELETE")).status).toBe(204);
  });
});

describe("decoding holds memory, so only two run at once (floor)", () => {
  it("a third upload is 429 with Retry-After while two are in flight, and a slot is free again when one ends", async () => {
    const bytes = await png(24, 24);
    const held = [0, 1].map(() => {
      let push: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          push = controller;
          controller.enqueue(new Uint8Array(bytes.subarray(0, 8)));
        },
      });
      const finish = () => {
        push?.enqueue(new Uint8Array(bytes.subarray(8)));
        push?.close();
      };
      return { stream, finish };
    });
    const pending = held.map(({ stream }) => call("PUT", bytes, { stream }));
    await new Promise((settle) => setTimeout(settle, 200));
    try {
      const third = await call("PUT", bytes, { who: bob });
      expect(third.status).toBe(429);
      expect(await codeOf(third)).toBe("too_many_requests");
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      for (const { finish } of held) finish();
    }
    expect((await Promise.all(pending)).map((answer) => answer.status)).toEqual([200, 200]);
    expect((await call("PUT", bytes, { who: bob })).status).toBe(200);
  }, 30_000);
});
