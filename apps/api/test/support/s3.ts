import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

// The S3-compatible simulator of the integration tests (README "local database"). Its keys are low-entropy test values
// that the simulator is started with; a test fails, never skips, when the simulator's address is not set.
export const S3_ACCESS_KEY = "shoutory-s3-access-1";
export const S3_SECRET_KEY = "shoutory-s3-secret-1";
const REGION = "us-east-1";

export function s3Url(): string {
  const url = process.env.SHOUTORY_TEST_S3_URL;
  if (!url) throw new Error("SHOUTORY_TEST_S3_URL is not set: start the S3 simulator (README)");
  return url;
}

/** The environment of an operator who chose the s3 driver, pointed at the simulator. */
export const s3Env = (bucket: string, overrides: Record<string, string> = {}): Record<string, string> => ({
  SHOUTORY_STORAGE_DRIVER: "s3",
  SHOUTORY_S3_ENDPOINT: s3Url(),
  SHOUTORY_S3_REGION: REGION,
  SHOUTORY_S3_BUCKET: bucket,
  SHOUTORY_S3_FORCE_PATH_STYLE: "true",
  SHOUTORY_S3_ACCESS_KEY_ID: S3_ACCESS_KEY,
  SHOUTORY_S3_SECRET_ACCESS_KEY: S3_SECRET_KEY,
  ...overrides,
});

/** Creates the bucket the driver will use; the driver never creates one. An existing bucket of ours is fine. */
export async function createBucket(name: string): Promise<void> {
  const client = new S3Client({
    region: REGION,
    endpoint: s3Url(),
    forcePathStyle: true,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: name }));
  } catch (error) {
    if ((error as { name?: string }).name !== "BucketAlreadyOwnedByYou") throw error;
  } finally {
    client.destroy();
  }
}
