import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageConfig } from "@shoutory/core/config";
import { checkRange, type StorageDriver, StorageError, storageKeySegments } from "@shoutory/core/storage";

// Bounds of every request the client makes (R344). `throwOnRequestTimeout` is needed: without it a request that outlasts
// `requestTimeout` only logs a warning.
const CONNECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
// The total time a streamed `get` body may take from the answer to its last byte, however slowly it still delivers.
const DEFAULT_BODY_DEADLINE_MS = 300_000;
const MAX_BODY_DEADLINE_MS = 3_600_000;

/** The whole body, or a refusal as soon as it passes `maxBytes`, before any request is made (R343). */
async function readBounded(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new StorageError("too_large");
    }
    chunks.push(value);
  }
}

const DENIED_NAMES = new Set(["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"]);

/**
 * What an SDK failure means to a caller. The result carries no SDK text, key, host or credential, so the kind is the
 * only signal: 412 an existing object (a conditional write), 501 a server without the conditional header (it cannot hold
 * immutable originals), 401, 403 and the credential error names a refusal of the keys, anything else a failure.
 */
function mapped(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const { name, $metadata } = (error ?? {}) as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = $metadata?.httpStatusCode;
  if (status === 412 || name === "PreconditionFailed") return new StorageError("exists");
  if (status === 501 || name === "NotImplemented") return new StorageError("unsupported");
  if (status === 401 || status === 403 || DENIED_NAMES.has(name ?? "")) return new StorageError("denied");
  return new StorageError("failed");
}

/** Runs one request and gives its failure as a storage class. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapped(error);
  }
}

const isNamed = (error: unknown, name: string) => (error as { name?: unknown } | null)?.name === name;

/** The body, cancelled and failed once `ms` have passed since the answer; a read error of the body is a failure too. */
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

/** The size and stored sha256 (hex) of a HEAD answer; no length at all is a failure, never a made-up 0. */
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

// An upload URL lives 15 minutes.
const PRESIGN_EXPIRY_SECONDS = 900;

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

/**
 * Upload URLs for browsers. The presigner holds its own client on the public endpoint, because the URL carries the
 * host of the client that signs it; the server's own client is unchanged. The declared length is signed
 * (`content-length`), so a body of another length is refused by the server; the content type is not signed.
 */
export function createS3Presigner(config: S3Config) {
  // No default checksum parameter is signed into the URL: a browser would have to send it too.
  const client = clientFor(config, config.publicEndpoint, { requestChecksumCalculation: "WHEN_REQUIRED" });
  return {
    /**
     * A PUT URL for `key` that accepts exactly `contentLength` bytes for 15 minutes after `signedAt`, and only while
     * nothing is stored there: the caller must send `If-None-Match: *`, which the URL signs, so it cannot replace an
     * object (an original is immutable).
     */
    async presignPut(
      key: string,
      contentLength: number,
      sha256: string,
      signedAt: Date = new Date(),
    ): Promise<{ url: string; headers: Record<string, string> }> {
      storageKeySegments(key);
      if (!Number.isSafeInteger(contentLength) || contentLength <= 0)
        throw new RangeError("contentLength must be a whole number of bytes above zero");
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new RangeError("sha256 must be 64 lower-case hex digits");
      const checksum = Buffer.from(sha256, "hex").toString("base64");
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ContentLength: contentLength,
        IfNoneMatch: "*",
        ChecksumSHA256: checksum,
      });
      // The presigner moves `x-amz-` headers into the query string, where S3-compatible servers may ignore the
      // checksum and store wrong bytes. Kept a signed header, a body that does not match is refused (BadDigest).
      const url = await getSignedUrl(client, command, {
        expiresIn: PRESIGN_EXPIRY_SECONDS,
        signingDate: signedAt,
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      });
      return { url, headers: { "if-none-match": "*", "x-amz-checksum-sha256": checksum } };
    },
  };
}

export type S3Presigner = ReturnType<typeof createS3Presigner>;

/**
 * Objects in one bucket of an S3-compatible server, under the storage key itself. The bucket must exist: the driver
 * never creates one. The credentials are read from their sealed form only when the SDK asks for them. One client
 * serves every call until `close`; a streamed body has `bodyDeadlineMs` in all (default 5 minutes, at most an hour).
 */
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
      const bytes = await readBounded(body, maxBytes);
      const ifAbsent = putOptions?.ifAbsent === true;
      const command = new PutObjectCommand({
        Bucket,
        Key: key,
        Body: bytes,
        IfNoneMatch: ifAbsent ? "*" : undefined,
      });
      await guarded(() => (ifAbsent ? onceClient : client).send(command));
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
    // An S3 bucket has no free-space figure to report.
    check: async () => ({ freeBytes: null }),
    close() {
      client.destroy();
      onceClient.destroy();
    },
  };
}
