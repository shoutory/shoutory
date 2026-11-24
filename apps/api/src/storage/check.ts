import { randomBytes, randomUUID } from "node:crypto";
import {
  type StorageCheckInfo,
  type StorageDriver,
  StorageError,
  type StorageWarning,
} from "@shoutory/core/storage";

type CheckFailure = "write_failed" | "read_failed" | "delete_failed" | "timeout";

// A failure is a class, never error text.
export interface StorageCheckResult {
  driver: StorageDriver["name"];
  writable: boolean;
  readable: boolean;
  free_bytes: number | null;
  failure: CheckFailure | null;
  // Closed codes, never text of the store.
  warnings: StorageWarning[];
}

interface CheckOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const PROBE_BYTES = 16;

class Lapse extends Error {}

// The work itself cannot be cancelled and may finish later.
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Lapse());
      return;
    }
    const lapse = () => reject(new Lapse());
    signal.addEventListener("abort", lapse, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", lapse));
  });
}

// The error text of a driver names paths and hosts, so none of it is kept.
async function step(
  failure: Exclude<CheckFailure, "timeout">,
  signal: AbortSignal,
  work: () => Promise<unknown>,
): Promise<CheckFailure | null> {
  try {
    await within(work(), signal);
    return null;
  } catch (error) {
    return error instanceof Lapse ? "timeout" : failure;
  }
}

// After a failed probe a storage failure of the report is expected (the same bucket that would not take the probe), so
// it adds nothing to the failure class.
async function inspected(
  driver: StorageDriver,
  signal: AbortSignal,
  probeFailed: boolean,
): Promise<StorageCheckInfo> {
  try {
    return await within(driver.check(), signal);
  } catch (error) {
    if (error instanceof Lapse || (probeFailed && error instanceof StorageError)) return { freeBytes: null };
    throw error;
  }
}

// After a lapse the probe object may be left behind: the driver's own call cannot be cancelled and nothing more is
// attempted.
export async function checkStorage(
  driver: StorageDriver,
  options: CheckOptions = {},
): Promise<StorageCheckResult> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const key = `.shoutory-check/${randomUUID()}`;
  const probe = randomBytes(PROBE_BYTES);
  const result: StorageCheckResult = {
    driver: driver.name,
    writable: false,
    readable: false,
    free_bytes: null,
    failure: null,
    warnings: [],
  };
  result.failure = await step("write_failed", signal, () =>
    driver.put(key, new Blob([probe]).stream(), probe.length),
  );
  if (result.failure === null) {
    result.writable = true;
    result.failure = await step("read_failed", signal, async () => {
      const body = await driver.get(key);
      if (body === null) throw new Error("the probe object is missing");
      if (!probe.equals(Buffer.from(await new Response(body).arrayBuffer()))) throw new Error("other bytes");
    });
    result.readable = result.failure === null;
  }
  if (result.writable && result.failure !== "timeout") {
    result.failure ??= await step("delete_failed", signal, () => driver.delete(key));
  }
  const info = await inspected(driver, signal, result.failure !== null);
  result.free_bytes = info.freeBytes;
  // Advice about a store that failed its probe would only add noise to the failure.
  if (result.failure === null) result.warnings = [...(info.warnings ?? [])];
  return result;
}
