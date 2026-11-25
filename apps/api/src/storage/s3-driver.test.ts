import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { parseStorageEnv } from "@shoutory/core/config";
import { StorageError } from "@shoutory/core/storage";
import { afterEach, describe, expect, it } from "vitest";
import { leaks } from "../../test/support/canary.js";
import { createS3Driver } from "./s3-driver.js";

// The S3 driver against a local server that answers the way a refusing S3 server does, naming the key, the caller and
// the host in its message. No S3 simulator is needed: the answers are the point.
const KEY = "media/canary-key-1";
const ACCESS_KEY = "canary-access-id-1";
const SECRET_KEY = "canary-secret-key-1";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  server = createServer(handler);
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const configFor = (endpoint: string) =>
  parseStorageEnv({
    SHOUTORY_STORAGE_DRIVER: "s3",
    SHOUTORY_S3_ENDPOINT: endpoint,
    SHOUTORY_S3_REGION: "us-east-1",
    SHOUTORY_S3_BUCKET: "unit-bucket-1",
    SHOUTORY_S3_FORCE_PATH_STYLE: "true",
    SHOUTORY_S3_ACCESS_KEY_ID: ACCESS_KEY,
    SHOUTORY_S3_SECRET_ACCESS_KEY: SECRET_KEY,
  }) as Extract<ReturnType<typeof parseStorageEnv>, { driver: "s3" }>;

const stream = (text: string) => new Blob([text]).stream();

type Driver = ReturnType<typeof createS3Driver>;
const put = (d: Driver) => d.put(KEY, stream("bytes"), 1024);
const putAbsent = (d: Driver) => d.put(KEY, stream("bytes"), 1024, { ifAbsent: true });
const get = (d: Driver) => d.get(KEY);
const head = (d: Driver) => d.head(KEY);
const remove = (d: Driver) => d.delete(KEY);

const MAPPING: [string, (d: Driver) => Promise<unknown>, number, string, string][] = [
  ["put refused with AccessDenied", put, 403, "AccessDenied", "denied"],
  ["get refused with AccessDenied", get, 403, "AccessDenied", "denied"],
  ["delete refused with AccessDenied", remove, 403, "AccessDenied", "denied"],
  ["head refused with AccessDenied", head, 403, "AccessDenied", "denied"],
  ["a wrong signature", get, 403, "SignatureDoesNotMatch", "denied"],
  ["an unknown access key", get, 400, "InvalidAccessKeyId", "denied"],
  ["an unauthenticated request", get, 401, "Unauthorized", "denied"],
  // Status 0: the server drops the connection without an answer.
  ["a server that drops the connection", get, 0, "", "failed"],
  ["a missing bucket", get, 404, "NoSuchBucket", "failed"],
  ["a server error", put, 500, "InternalError", "failed"],
  [
    "a server that does not implement the conditional header",
    putAbsent,
    501,
    "NotImplemented",
    "unsupported",
  ],
  ["an object that already exists", putAbsent, 412, "PreconditionFailed", "exists"],
];

describe("s3 driver: a refused request", () => {
  it.each(MAPPING)(
    "reaches the caller from %s as a storage class with the right kind and no key, host or credential",
    async (_name, run, status, code, kind) => {
      const endpoint = await listen((request, response) => {
        const caller = /Credential=([^/]+)\//.exec(String(request.headers.authorization))?.[1] ?? "";
        if (status === 0) {
          request.socket.destroy();
          return;
        }
        response.writeHead(status, { "content-type": "application/xml" });
        response.end(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${caller} may not use ${request.url} on ${request.headers.host}</Message></Error>`,
        );
      });
      const error: unknown = await run(createS3Driver(configFor(endpoint))).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ kind });
      const own = Object.fromEntries(Object.getOwnPropertyNames(error).map((n) => [n, (error as never)[n]]));
      const haystack = [
        String(error),
        (error as Error).stack,
        JSON.stringify(own),
        inspect(error, { depth: 10 }),
      ].join("\n");
      const host = endpoint.replace("http://", "");
      expect(leaks(haystack, [KEY, "canary-key-1", ACCESS_KEY, SECRET_KEY, host])).toEqual([]);
    },
  );
});

describe("s3 driver: retries and a head with no length", () => {
  it.each([
    [
      "a write that must not replace is sent once, so a lost answer is a failure and never a false exists",
      true,
      1,
    ],
    ["a plain write is retried", false, 3],
  ])("%s", async (_name, ifAbsent, attempts) => {
    let requests = 0;
    const endpoint = await listen((_request, response) => {
      requests += 1;
      response.writeHead(500, { "content-type": "application/xml" });
      response.end("<Error><Code>InternalError</Code></Error>");
    });
    const driver = createS3Driver(configFor(endpoint));
    await expect(driver.put(KEY, stream("bytes"), 1024, { ifAbsent })).rejects.toMatchObject({
      kind: "failed",
    });
    expect(requests).toBe(attempts);
  });

  it.each([
    ["a composite checksum of a multipart object", `${Buffer.alloc(32, 1).toString("base64")}-3`],
    ["a checksum that is not 32 bytes", Buffer.alloc(5, 1).toString("base64")],
    ["a checksum that is not base64", "***"],
  ])("keeps no sha256 for %s, only the size", async (_name, checksum) => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { "content-length": "5", "x-amz-checksum-sha256": checksum });
      response.end();
    });
    expect(await head(createS3Driver(configFor(endpoint)))).toEqual({ size: 5 });
  });

  it("keeps the sha256 of 32 bytes", async () => {
    const digest = Buffer.alloc(32, 7);
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { "content-length": "5", "x-amz-checksum-sha256": digest.toString("base64") });
      response.end();
    });
    expect(await head(createS3Driver(configFor(endpoint)))).toEqual({
      size: 5,
      sha256: digest.toString("hex"),
    });
  });

  it("answers failed, not size 0, for a head that carries no length", async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    await expect(head(createS3Driver(configFor(endpoint)))).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("s3 driver: a streamed get body", () => {
  it("is cancelled once it passes the total deadline, even while it still delivers", async () => {
    let closedByClient = false;
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { "content-length": "1000000" });
      response.write("first-chunk");
      response.on("close", () => {
        closedByClient = true;
      });
    });
    const driver = createS3Driver(configFor(endpoint), { bodyDeadlineMs: 200 });
    const body = (await driver.get(KEY)) as ReadableStream<Uint8Array>;
    const reader = body.getReader();
    expect((await reader.read()).done).toBe(false);
    const stalled = Symbol("stalled");
    const next = await Promise.race([
      reader.read().then(
        () => "ended" as const,
        (error: unknown) => error,
      ),
      new Promise<symbol>((done) => setTimeout(() => done(stalled), 1500)),
    ]);
    expect(next).not.toBe(stalled);
    expect(next).toBeInstanceOf(StorageError);
    expect(next).toMatchObject({ kind: "failed" });
    await new Promise((done) => setTimeout(done, 200));
    expect(closedByClient).toBe(true);
  });
});

const MIB = 1024 * 1024;
const sized = (bytes: number) => new Blob([Buffer.alloc(bytes, "large-body-")]).stream();
const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("base64");

// A stub that takes every request as S3 would and records what each carried.
async function recordingServer() {
  const seen: { method: string; url: string; headers: Record<string, unknown>; body: Buffer }[] = [];
  const endpoint = await listen(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const url = request.url ?? "";
    seen.push({ method: request.method ?? "", url, headers: request.headers, body: Buffer.concat(chunks) });
    const xml = { "content-type": "application/xml" };
    if (/[?&]uploads/.test(url)) {
      response.writeHead(200, xml);
      response.end(
        "<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>",
      );
    } else if (request.method === "POST") {
      response.writeHead(200, xml);
      response.end('<CompleteMultipartUploadResult><ETag>"whole"</ETag></CompleteMultipartUploadResult>');
    } else {
      response.writeHead(200, { etag: `"part-${seen.length}"` });
      response.end();
    }
  });
  return { endpoint, seen };
}

describe("s3 driver: a large put", () => {
  it.each([
    ["of exactly 64 MiB is one request", 64 * MIB, ["PUT"]],
    [
      "of 64 MiB + 1 goes in parts of 16 MiB, each with its sha256",
      64 * MIB + 1,
      ["POST", "PUT", "PUT", "PUT", "PUT", "PUT", "POST"],
    ],
  ])("%s", async (_name, size, methods) => {
    const { endpoint, seen } = await recordingServer();
    await createS3Driver(configFor(endpoint)).put(KEY, sized(size), size);
    expect(seen.map(({ method }) => method)).toEqual(methods);
    const parts = seen.filter(({ url }) => /partNumber=/.test(url));
    expect(parts.map(({ body }) => body.length)).toEqual(
      methods.length > 1 ? [16 * MIB, 16 * MIB, 16 * MIB, 16 * MIB, 1] : [],
    );
    for (const { headers, body } of parts) expect(headers["x-amz-checksum-sha256"]).toBe(sha256Of(body));
    if (parts.length > 0) expect(seen.at(-1)?.headers["x-amz-mp-object-size"]).toBe(String(size));
  });
});

const abortRule = (
  days: number,
  { filter = "<Filter><Prefix></Prefix></Filter>", status = "Enabled" } = {},
) =>
  `<Rule><ID>r</ID>${filter}<Status>${status}</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>${days}</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>`;
const configuration = (...rules: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${rules.join("")}</LifecycleConfiguration>`;
const refusal = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${KEY} on unit-bucket-1 for ${ACCESS_KEY}</Message></Error>`;

const LIFECYCLE: [string, number, string, string[]][] = [
  [
    "a bucket with no lifecycle configuration",
    404,
    refusal("NoSuchLifecycleConfiguration"),
    ["no_abort_rule"],
  ],
  ["a rule of 7 days over every key", 200, configuration(abortRule(7)), []],
  [
    "a rule of 3 days over the legacy empty prefix",
    200,
    configuration(abortRule(3, { filter: "<Prefix/>" })),
    [],
  ],
  [
    "a rule of 7 days over the prefix ws/",
    200,
    configuration(abortRule(7, { filter: "<Filter><Prefix>ws/</Prefix></Filter>" })),
    [],
  ],
  ["a rule of 30 days", 200, configuration(abortRule(30)), ["abort_rule_too_long"]],
  ["a fast rule beside a slow one", 200, configuration(abortRule(30), abortRule(2)), []],
  [
    "a rule for another prefix",
    200,
    configuration(abortRule(7, { filter: "<Filter><Prefix>other/</Prefix></Filter>" })),
    ["abort_rule_excludes_uploads"],
  ],
  [
    "a rule for one workspace only",
    200,
    configuration(abortRule(7, { filter: "<Filter><Prefix>ws/some-workspace/</Prefix></Filter>" })),
    ["abort_rule_excludes_uploads"],
  ],
  [
    "a rule with a tag filter",
    200,
    configuration(abortRule(7, { filter: "<Filter><Tag><Key>a</Key><Value>b</Value></Tag></Filter>" })),
    ["abort_rule_excludes_uploads"],
  ],
  ["a disabled rule", 200, configuration(abortRule(7, { status: "Disabled" })), ["no_abort_rule"]],
  [
    "a rule that expires objects and never aborts uploads",
    200,
    configuration(
      "<Rule><ID>e</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration></Rule>",
    ),
    ["no_abort_rule"],
  ],
  ["a server that refuses the read", 403, refusal("AccessDenied"), ["abort_rule_unreadable"]],
  ["a server without the lifecycle API", 501, refusal("NotImplemented"), ["abort_rule_unreadable"]],
];

describe("s3 driver: the lifecycle warnings of its check", () => {
  it.each(LIFECYCLE)("%s", async (_name, status, body, warnings) => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(status, { "content-type": "application/xml" });
      response.end(body);
    });
    const answer = await createS3Driver(configFor(endpoint)).check();
    expect(answer).toEqual({ freeBytes: null, warnings });
    const host = endpoint.replace("http://", "");
    expect(leaks(JSON.stringify(answer), [KEY, ACCESS_KEY, SECRET_KEY, "unit-bucket-1", host])).toEqual([]);
  });

  it("lets any other failure of the read through as a storage failure, never as a warning", async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end(refusal("NoSuchBucket"));
    });
    await expect(createS3Driver(configFor(endpoint)).check()).rejects.toMatchObject({ kind: "failed" });
  });

  it("only reads the configuration: no request of the check is a write", async () => {
    const methods: string[] = [];
    const endpoint = await listen((request, response) => {
      methods.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(configuration(abortRule(7)));
    });
    await createS3Driver(configFor(endpoint)).check();
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatch(/^GET \/unit-bucket-1\/?\?lifecycle/);
  });
});
