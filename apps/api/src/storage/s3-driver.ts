import { createHash } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type LifecycleRule,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageConfig } from "@shoutory/core/config";
import {
  checkRange,
  type StorageDriver,
  StorageError,
  type StorageWarning,
  storageKeySegments,
} from "@shoutory/core/storage";

// Bounds of every request the client makes. `throwOnRequestTimeout` is needed: without it a request that outlasts
// `requestTimeout` only logs a warning.
const CONNECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
// The total time a streamed `get` body may take from the answer to its last byte, however slowly it still delivers.
const DEFAULT_BODY_DEADLINE_MS = 300_000;
const MAX_BODY_DEADLINE_MS = 3_600_000;

// A body up to 64 MiB goes in one request; a larger one goes in parts of 16 MiB, so memory holds about 150 MiB at most
// (the first 80 MiB of parts and the copies made while joining them) whatever the size. At 16 MiB the 10,000 parts S3 allows reach about 156 GiB.
const SINGLE_PUT_MAX = 64 * 1024 * 1024;
const PART_BYTES = 16 * 1024 * 1024;

// Parts of PART_BYTES, the last one shorter. A body past maxBytes is refused, and a consumer that stops early cancels it.
async function* partsOf(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  let open = true;
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read().catch((error: unknown) => {
        open = false;
        throw error;
      });
      if (next.done) break;
      total += next.value.length;
      if (total > maxBytes) throw new StorageError("too_large");
      held.push(next.value);
      heldBytes += next.value.length;
      while (heldBytes >= PART_BYTES) {
        const joined = Buffer.concat(held);
        held = [joined.subarray(PART_BYTES)];
        heldBytes -= PART_BYTES;
        yield joined.subarray(0, PART_BYTES);
      }
    }
    open = false;
    if (heldBytes > 0) yield Buffer.concat(held);
  } finally {
    if (open) await reader.cancel();
  }
}

function putWhole({ client, onceClient, Bucket, Key, ifAbsent }: PutTarget, Body: Buffer): Promise<void> {
  const command = new PutObjectCommand({ Bucket, Key, Body, IfNoneMatch: ifAbsent ? "*" : undefined });
  return guarded(async () => {
    await (ifAbsent ? onceClient : client).send(command);
  });
}

interface PutTarget {
  readonly client: S3Client;
  readonly onceClient: S3Client;
  readonly Bucket: string;
  readonly Key: string;
  readonly ifAbsent: boolean;
}

// The sequence is the driver's own, not the browser multipart: every part carries its sha256, and the complete is sent
// once with `If-None-Match: *` when it must not replace.
async function putInParts(target: PutTarget, first: Buffer[], rest: AsyncGenerator<Buffer>): Promise<void> {
  const { client, onceClient, Bucket, Key, ifAbsent } = target;
  const created = await guarded(() =>
    client.send(new CreateMultipartUploadCommand({ Bucket, Key, ChecksumAlgorithm: "SHA256" })),
  );
  const UploadId = created.UploadId;
  if (!UploadId) throw new StorageError("failed");
  try {
    const Parts = await uploadParts(target, UploadId, first, rest);
    const MpuObjectSize = Parts.reduce((sum, part) => sum + part.size, 0);
    await (ifAbsent ? onceClient : client).send(
      new CompleteMultipartUploadCommand({
        Bucket,
        Key,
        UploadId,
        IfNoneMatch: ifAbsent ? "*" : undefined,
        MpuObjectSize,
        MultipartUpload: { Parts: Parts.map(({ size: _size, ...part }) => part) },
      }),
    );
  } catch (error) {
    // The first failure is the one reported. An abort that fails too leaves parts the bucket's abort rule removes,
    // the rule the check advises.
    await client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })).catch(() => undefined);
    throw mapped(error);
  }
}

async function uploadParts(
  target: PutTarget,
  UploadId: string,
  first: Buffer[],
  rest: AsyncGenerator<Buffer>,
) {
  const { client, Bucket, Key } = target;
  const parts: { PartNumber: number; ETag: string; ChecksumSHA256: string; size: number }[] = [];
  const send = async (bytes: Buffer) => {
    const PartNumber = parts.length + 1;
    if (PartNumber > MAX_PART_NUMBER) throw new StorageError("too_large");
    const ChecksumSHA256 = createHash("sha256").update(bytes).digest("base64");
    const answer = await client.send(
      new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body: bytes, ChecksumSHA256 }),
    );
    if (!answer.ETag) throw new StorageError("failed");
    parts.push({ PartNumber, ETag: answer.ETag, ChecksumSHA256, size: bytes.length });
  };
  for (const bytes of first.splice(0)) await send(bytes);
  for await (const bytes of rest) await send(bytes);
  return parts;
}

const DENIED_NAMES = new Set(["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"]);

// The result carries no SDK text, key, host or credential. 501 is a server without the conditional header, which cannot
// hold immutable originals.
function mapped(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const { name, $metadata } = (error ?? {}) as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = $metadata?.httpStatusCode;
  if (status === 412 || name === "PreconditionFailed") return new StorageError("exists");
  if (status === 501 || name === "NotImplemented") return new StorageError("unsupported");
  if (status === 401 || status === 403 || DENIED_NAMES.has(name ?? "")) return new StorageError("denied");
  return new StorageError("failed");
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapped(error);
  }
}

const isNamed = (error: unknown, name: string) => (error as { name?: unknown } | null)?.name === name;

function withDeadline(source: ReadableStream<Uint8Array>, ms: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        expired = true;
        reader.cancel().catch(() => undefined);
        controller.error(new StorageError("failed"));
      }, ms);
      timer.unref();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (expired) return;
        if (done) {
          clearTimeout(timer);
          controller.close();
        } else controller.enqueue(value);
      } catch {
        clearTimeout(timer);
        if (!expired) controller.error(new StorageError("failed"));
      }
    },
    cancel(reason) {
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
}

const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

function headFacts(answer: { ContentLength?: number | undefined; ChecksumSHA256?: string | undefined }): {
  size: number;
  sha256?: string;
} {
  if (answer.ContentLength === undefined) throw new StorageError("failed");
  // A sha256 of 32 bytes only: a multipart object carries a composite checksum ("<base64>-<parts>") that is no digest.
  if (!answer.ChecksumSHA256 || !SHA256_BASE64.test(answer.ChecksumSHA256))
    return { size: answer.ContentLength };
  return { size: answer.ContentLength, sha256: Buffer.from(answer.ChecksumSHA256, "base64").toString("hex") };
}

type S3Config = Extract<StorageConfig, { driver: "s3" }>;

const PRESIGN_EXPIRY_SECONDS = 900;
// S3 numbers the parts of an upload from 1 to 10,000; one page of ListParts holds at most 1,000 of them.
const MAX_PART_NUMBER = 10_000;
const MAX_LIST_PAGES = MAX_PART_NUMBER / 1000;

const clientFor = (config: S3Config, endpoint: string, extra: Partial<S3ClientConfig> = {}) =>
  new S3Client({
    ...extra,
    region: config.region,
    endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: async () => ({
      accessKeyId: config.accessKeyId.expose(),
      secretAccessKey: config.secretAccessKey.expose(),
    }),
    requestHandler: {
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });

function checksumOf(contentLength: number, sha256: string): string {
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0)
    throw new RangeError("contentLength must be a whole number of bytes above zero");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new RangeError("sha256 must be 64 lower-case hex digits");
  return Buffer.from(sha256, "hex").toString("base64");
}

// The presigner holds its own client on the public endpoint, because the URL carries the host of the client that signs
// it. The declared length is signed (`content-length`), so a body of another length is refused by the server.
export function createS3Presigner(config: S3Config) {
  // No default checksum parameter is signed into the URL: a browser would have to send it too.
  const client = clientFor(config, config.publicEndpoint, { requestChecksumCalculation: "WHEN_REQUIRED" });
  // The presigner moves `x-amz-` headers into the query string, where S3-compatible servers may ignore the checksum and
  // store wrong bytes. Kept a signed header, a body that does not match is refused (BadDigest).
  const signing = (signingDate: Date) => ({
    expiresIn: PRESIGN_EXPIRY_SECONDS,
    signingDate,
    unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
  });
  return {
    // Parts are signed one by one because each carries its own digest, which only the browser that holds the bytes knows.
    async presignPart(
      key: string,
      uploadId: string,
      partNumber: number,
      contentLength: number,
      sha256: string,
      signedAt: Date = new Date(),
    ): Promise<{ url: string; headers: Record<string, string> }> {
      storageKeySegments(key);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER)
        throw new RangeError("partNumber must be a whole number from 1 to 10000");
      const checksum = checksumOf(contentLength, sha256);
      const command = new UploadPartCommand({
        Bucket: config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
        ChecksumSHA256: checksum,
      });
      const url = await getSignedUrl(client, command, signing(signedAt));
      return { url, headers: { "x-amz-checksum-sha256": checksum } };
    },
    // The caller must send `If-None-Match: *`, which the URL signs, so it cannot replace an object (an original is
    // immutable).
    async presignPut(
      key: string,
      contentLength: number,
      sha256: string,
      signedAt: Date = new Date(),
    ): Promise<{ url: string; headers: Record<string, string> }> {
      storageKeySegments(key);
      const checksum = checksumOf(contentLength, sha256);
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ContentLength: contentLength,
        IfNoneMatch: "*",
        ChecksumSHA256: checksum,
      });
      return {
        url: await getSignedUrl(client, command, signing(signedAt)),
        headers: { "if-none-match": "*", "x-amz-checksum-sha256": checksum },
      };
    },
  };
}

export type S3Presigner = ReturnType<typeof createS3Presigner>;

export interface UploadedPart {
  readonly number: number;
  readonly size: number;
  readonly etag: string;
  readonly checksum?: string;
}

async function listAllParts(
  client: S3Client,
  Bucket: string,
  Key: string,
  UploadId: string,
): Promise<UploadedPart[] | null> {
  const parts: UploadedPart[] = [];
  let PartNumberMarker: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const answer = await listPage(client, { Bucket, Key, UploadId, PartNumberMarker });
    if (answer === null) return null;
    parts.push(...(answer.Parts ?? []).map(uploadedPart));
    if (!answer.IsTruncated) return parts;
    PartNumberMarker = answer.NextPartNumberMarker;
  }
  throw new StorageError("failed");
}

async function listPage(client: S3Client, input: ConstructorParameters<typeof ListPartsCommand>[0]) {
  try {
    return await client.send(new ListPartsCommand(input));
  } catch (error) {
    if (isNamed(error, "NoSuchUpload")) return null;
    throw error;
  }
}

function uploadedPart(part: {
  PartNumber?: number | undefined;
  Size?: number | undefined;
  ETag?: string | undefined;
  ChecksumSHA256?: string | undefined;
}): UploadedPart {
  if (part.PartNumber === undefined || part.Size === undefined || part.ETag === undefined)
    throw new StorageError("failed");
  const checksum = part.ChecksumSHA256 ? { checksum: part.ChecksumSHA256 } : {};
  return { number: part.PartNumber, size: part.Size, etag: part.ETag, ...checksum };
}

// A complete is attempted once and never replaces an object (`If-None-Match: *`), and it states the size it expects, so
// storage refuses a list that does not add up to it.
export function createS3Multipart(config: S3Config) {
  const client = clientFor(config, config.endpoint);
  const onceClient = clientFor(config, config.endpoint, { maxAttempts: 1 });
  const Bucket = config.bucket;
  return {
    async createUpload(key: string): Promise<{ uploadId: string }> {
      storageKeySegments(key);
      const answer = await guarded(() =>
        client.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ChecksumAlgorithm: "SHA256" })),
      );
      if (!answer.UploadId) throw new StorageError("failed");
      return { uploadId: answer.UploadId };
    },
    async listParts(key: string, uploadId: string): Promise<UploadedPart[] | null> {
      storageKeySegments(key);
      return guarded(() => listAllParts(client, Bucket, key, uploadId));
    },
    async complete(
      key: string,
      uploadId: string,
      parts: readonly { number: number; etag: string; checksum?: string }[],
      objectSize: number,
    ): Promise<void> {
      storageKeySegments(key);
      const command = new CompleteMultipartUploadCommand({
        Bucket,
        Key: key,
        UploadId: uploadId,
        IfNoneMatch: "*",
        MpuObjectSize: objectSize,
        MultipartUpload: {
          Parts: parts.map(({ number, etag, checksum }) => ({
            PartNumber: number,
            ETag: etag,
            ...(checksum ? { ChecksumSHA256: checksum } : {}),
          })),
        },
      });
      // An upload storage no longer has was finished (or removed) by an earlier complete: the caller settles by the object.
      await guarded(async () => {
        try {
          await onceClient.send(command);
        } catch (error) {
          if (!isNamed(error, "NoSuchUpload")) throw error;
        }
      });
    },
    async abort(key: string, uploadId: string): Promise<void> {
      storageKeySegments(key);
      await guarded(async () => {
        try {
          await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
        } catch (error) {
          if (!isNamed(error, "NoSuchUpload")) throw error;
        }
      });
    },
    close(): void {
      client.destroy();
      onceClient.destroy();
    },
  };
}

export type S3Multipart = ReturnType<typeof createS3Multipart>;

// Abandoned parts of a multipart upload cost storage until the bucket aborts them: a rule that does so within 7 days
// for the keys the app writes (`ws/<workspace>/...`) is the advice of the check.
const UPLOAD_KEY_PREFIX = "ws/";
const MAX_ABORT_DAYS = 7;

const prefixOf = (rule: LifecycleRule) =>
  rule.Filter?.And?.Prefix ?? rule.Filter?.Prefix ?? rule.Prefix ?? "";
const tagged = (rule: LifecycleRule) => rule.Filter?.Tag !== undefined || !!rule.Filter?.And?.Tags?.length;

// A rule counts when it is enabled, aborts uploads, has no tag filter and covers `ws/`.
function lifecycleWarnings(rules: readonly LifecycleRule[]): StorageWarning[] {
  const aborting = rules.filter(
    (rule) =>
      rule.Status === "Enabled" && rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== undefined,
  );
  if (aborting.length === 0) return ["no_abort_rule"];
  const covering = aborting.filter((rule) => !tagged(rule) && UPLOAD_KEY_PREFIX.startsWith(prefixOf(rule)));
  if (covering.length === 0) return ["abort_rule_excludes_uploads"];
  const days = covering.map((rule) => rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? Infinity);
  return Math.min(...days) <= MAX_ABORT_DAYS ? [] : ["abort_rule_too_long"];
}

const UNREADABLE_NAMES = new Set(["AccessDenied", "NotImplemented"]);

// Never writes a configuration. A server that refuses the read or has no such API is "unreadable".
async function lifecycleAdvice(client: S3Client, Bucket: string): Promise<StorageWarning[]> {
  try {
    const answer = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket }));
    return lifecycleWarnings(answer.Rules ?? []);
  } catch (error) {
    const { name, $metadata } = (error ?? {}) as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (name === "NoSuchLifecycleConfiguration") return ["no_abort_rule"];
    const status = $metadata?.httpStatusCode;
    if (UNREADABLE_NAMES.has(name ?? "") || status === 403 || status === 501)
      return ["abort_rule_unreadable"];
    throw mapped(error);
  }
}

async function putBounded(
  target: PutTarget,
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<void> {
  const parts = partsOf(body, maxBytes);
  const first: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await parts.next();
      if (next.done) return await putWhole(target, Buffer.concat(first));
      first.push(next.value);
      size += next.value.length;
      if (size > SINGLE_PUT_MAX) return await putInParts(target, first, parts);
    }
  } finally {
    await parts.return(undefined);
  }
}

// The bucket must exist: the driver never creates one. The credentials are read from their sealed form only when the
// SDK asks for them.
export function createS3Driver(config: S3Config, options: { bodyDeadlineMs?: number } = {}): StorageDriver {
  const deadline = options.bodyDeadlineMs ?? DEFAULT_BODY_DEADLINE_MS;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > MAX_BODY_DEADLINE_MS)
    throw new RangeError("bodyDeadlineMs must be a whole number of milliseconds from 1 to 3600000");
  const client = clientFor(config, config.endpoint);
  // A write that must not replace is never retried: a lost answer then reads as a failure, where a retry would meet
  // its own first attempt and answer a false `exists`.
  const onceClient = clientFor(config, config.endpoint, { maxAttempts: 1 });
  const Bucket = config.bucket;
  return {
    name: "s3",
    async put(key, body, maxBytes, putOptions) {
      storageKeySegments(key);
      const ifAbsent = putOptions?.ifAbsent === true;
      await putBounded({ client, onceClient, Bucket, Key: key, ifAbsent }, body, maxBytes);
    },
    async get(key, range) {
      storageKeySegments(key);
      if (range) checkRange(range);
      const Range = range ? `bytes=${range.start}-${range.end}` : undefined;
      return guarded(async () => {
        try {
          const answer = await client.send(new GetObjectCommand({ Bucket, Key: key, Range }));
          return answer.Body ? withDeadline(answer.Body.transformToWebStream(), deadline) : null;
        } catch (error) {
          if (isNamed(error, "NoSuchKey")) return null;
          // A start past the end of the object: nothing to read, as on the filesystem.
          if (isNamed(error, "InvalidRange")) return new Blob([]).stream();
          throw error;
        }
      });
    },
    async head(key) {
      storageKeySegments(key);
      return guarded(async () => {
        try {
          const answer = await client.send(
            new HeadObjectCommand({ Bucket, Key: key, ChecksumMode: "ENABLED" }),
          );
          return headFacts(answer);
        } catch (error) {
          if (isNamed(error, "NotFound")) return null;
          throw error;
        }
      });
    },
    async delete(key) {
      storageKeySegments(key);
      await guarded(() => client.send(new DeleteObjectCommand({ Bucket, Key: key })));
    },
    // An S3 bucket has no free-space figure to report; its advice is the lifecycle rule that aborts abandoned uploads.
    check: async () => ({ freeBytes: null, warnings: await lifecycleAdvice(client, Bucket) }),
    close() {
      client.destroy();
      onceClient.destroy();
    },
  };
}
