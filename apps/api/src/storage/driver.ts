import type { StorageConfig } from "@shoutory/core/config";
import type { StorageDriver } from "@shoutory/core/storage";
import { createFsDriver } from "./fs-driver.js";
import { createS3Driver } from "./s3-driver.js";

export function createStorageDriver(config: StorageConfig): StorageDriver {
  return config.driver === "fs" ? createFsDriver(config.dataDir) : createS3Driver(config);
}
