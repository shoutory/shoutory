import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StorageConfig } from "@shoutory/core/config";
import { type StorageDriver, StorageError, storageKeySegments } from "@shoutory/core/storage";

// Bounds of every request the client makes (R344). `throwOnRequestTimeout` is needed: without it a request that outlasts
// `requestTimeout` only logs a warning.
const CONNECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

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

const isNoSuchKey = (error: unknown) => (error as { name?: unknown } | null)?.name === "NoSuchKey";

/**
 * Objects in one bucket of an S3-compatible server, under the storage key itself. The bucket must exist: the driver
 * never creates one. The credentials are read from their sealed form only when the SDK asks for them.
 */
export function createS3Driver(config: Extract<StorageConfig, { driver: "s3" }>): StorageDriver {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
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
  const Bucket = config.bucket;
  return {
    name: "s3",
    async put(key, body, maxBytes) {
      storageKeySegments(key);
      const bytes = await readBounded(body, maxBytes);
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes }));
    },
    async get(key) {
      storageKeySegments(key);
      try {
        const answer = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return answer.Body ? (answer.Body.transformToWebStream() as ReadableStream<Uint8Array>) : null;
      } catch (error) {
        if (isNoSuchKey(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      storageKeySegments(key);
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    // An S3 bucket has no free-space figure to report.
    check: async () => ({ freeBytes: null }),
  };
}
