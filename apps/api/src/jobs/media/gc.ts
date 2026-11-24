import { randomUUID } from "node:crypto";
import { type StorageDriver, StorageError } from "@shoutory/core/storage";
import { type TenantTx, withTenant } from "@shoutory/db/context";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { Logger } from "../../logging/logger.js";

// The database decides what may go: `media_gc_take` reads the rule again under the row lock, and the job deletes only the
// keys it answers, outside any transaction. A failed delete leaves the asset deleted without the removal record, so the
// 30-day arm offers it again; a missing key is a no-op for both drivers, so the retry removes what is left.

const BATCH = 200;
const MAX_BATCHES = 50;
const DEFAULT_DEADLINE_MS = 10 * 60_000;

export interface GcDeps {
  readonly pool: AppPool;
  readonly storage: StorageDriver;
  readonly logger: Logger;
}
export interface GcResult {
  taken: number;
  removed: number;
  failed: number;
  cut: boolean;
}
interface Candidate {
  workspace_id: string;
  asset_id: string;
  arm: string;
}

const asJobOf = <T>(pool: AppPool, workspaceId: string, work: (tx: TenantTx) => Promise<T>) =>
  withTenant(pool, { principalKind: "job", principalId: randomUUID(), workspaceIds: [workspaceId] }, work);

async function take(pool: AppPool, candidate: Candidate): Promise<string[]> {
  const found = await asJobOf(pool, candidate.workspace_id, (tx) =>
    tx.query<{ object_key: string }>("SELECT object_key FROM app.media_gc_take($1, $2, $3)", [
      candidate.workspace_id,
      candidate.asset_id,
      candidate.arm,
    ]),
  );
  return found.rows.map((row) => row.object_key);
}

// A storage failure of one key is logged with the asset and its class, never the key, and the others are still tried.
async function removeKeys(
  storage: StorageDriver,
  keys: readonly string[],
  logger: Logger,
  mediaId: string,
): Promise<number> {
  let failed = 0;
  for (const key of keys) {
    try {
      await storage.delete(key);
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      failed++;
      logger.warn({ mediaId, storageError: error.kind }, "a media object could not be deleted");
    }
  }
  return failed;
}

async function collectOne(deps: GcDeps, candidate: Candidate): Promise<"skipped" | "removed" | "failed"> {
  const keys = await take(deps.pool, candidate);
  if (keys.length === 0) return "skipped";
  const failed = await removeKeys(deps.storage, keys, deps.logger, candidate.asset_id);
  if (failed > 0) return "failed";
  await asJobOf(deps.pool, candidate.workspace_id, (tx) =>
    tx.query("SELECT app.media_object_removed($1, $2)", [candidate.workspace_id, candidate.asset_id]),
  );
  return "removed";
}

const candidatesOf = (pool: AppPool, limit: number, after: string | null) =>
  withSystem(
    pool,
    "maintenance",
    async (tx) =>
      (
        await tx.query<Candidate>("SELECT workspace_id, asset_id, arm FROM app.media_gc_candidates($1, $2)", [
          limit,
          after,
        ])
      ).rows,
  );

// Each list starts after the last id of the one before, so a candidate whose delete keeps failing is tried once and
// never holds the run back; what a cut run leaves is offered again the next night.
export async function collectMedia(
  deps: GcDeps,
  { limit = BATCH, deadlineMs = DEFAULT_DEADLINE_MS }: { limit?: number; deadlineMs?: number } = {},
): Promise<GcResult> {
  const stopAt = Date.now() + deadlineMs;
  const result: GcResult = { taken: 0, removed: 0, failed: 0, cut: false };
  let after: string | null = null;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const listed = await candidatesOf(deps.pool, limit, after);
    if (listed.length === 0) return finished(deps.logger, result);
    for (const candidate of listed) {
      if (Date.now() >= stopAt) return finished(deps.logger, { ...result, cut: true });
      tally(result, await collectOne(deps, candidate));
    }
    after = listed[listed.length - 1]?.asset_id ?? null;
  }
  return finished(deps.logger, { ...result, cut: true });
}

function tally(result: GcResult, outcome: "skipped" | "removed" | "failed"): void {
  if (outcome === "skipped") return;
  result.taken++;
  if (outcome === "removed") result.removed++;
  else result.failed++;
}

function finished(logger: Logger, result: GcResult): GcResult {
  if (result.cut) logger.warn(result, "the media collection stopped before it ran out of work");
  else logger.info(result, "the media collection finished");
  return result;
}
