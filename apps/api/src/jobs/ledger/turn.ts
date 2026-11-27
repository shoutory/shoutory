import { claimOperation, publishLeaseSeconds, rereadOutcome } from "@shoutory/core/ledger/client";
import { backoffSeconds } from "@shoutory/core/ledger/dispatch";
import type { StorageDriver } from "@shoutory/core/storage";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { AdapterMap } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { Registry } from "@shoutory/provider-sdk/registry";
import { pastSunset } from "@shoutory/provider-sdk/snapshot";
import type { CredentialService } from "../../channels/credentials.js";
import type { Logger } from "../../logging/logger.js";
import { accessOf } from "./account.js";
import { dispatch } from "./dispatch.js";
import { hold } from "./heartbeat.js";
import {
  type ChannelFacts,
  type Held,
  handBack,
  inJob,
  type Operation,
  preflightMove,
  readOperation,
  sqlOf,
  type TurnResult,
  takeLimits,
} from "./held.js";

export type { TurnResult } from "./held.js";

export interface TurnOptions {
  readonly pool: AppPool;
  readonly logger: Logger;
  readonly registry: Registry;
  readonly adapters: AdapterMap;
  readonly fetchFor: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
  readonly credentials: CredentialService;
  readonly queue: string;
  readonly owner: string;
  readonly closing: AbortSignal;
  readonly storage?: StorageDriver;
  readonly now?: () => number;
  readonly clock?: () => Date;
}

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const { pool, closing, now = () => performance.now() } = options;
  if (closing.aborted) return { kind: "closed" };
  const started = now();
  const claim = await withSystem(pool, "ledger", (tx) =>
    claimOperation(sqlOf(tx), options.queue, options.owner),
  );
  if (claim === null) return { kind: "idle" };
  const operation = await readOperation(pool, claim);
  const manifest = options.registry.manifests.find((candidate) => candidate.id === operation.provider_id);
  if (manifest === undefined) {
    options.logger.error({ provider: operation.provider_id }, "claimed operation has no registered provider");
    throw new Error(`no provider "${operation.provider_id}" is registered`);
  }
  const holding = hold({
    pool,
    logger: options.logger,
    claim,
    operation,
    manifest,
    leaseSeconds: publishLeaseSeconds(manifest.leaseSeconds),
    owner: options.owner,
    now,
    started,
  });
  try {
    return await preflight(options, holding.held);
  } finally {
    await holding.stop();
  }
}

export async function readTarget(pool: AppPool, operation: Operation) {
  return inJob(pool, operation.workspace_id, async (tx) => {
    const channel = await tx.query<ChannelFacts>(
      `SELECT provider_id, provider_account_id, instance_host, connection_state
         FROM app.channels WHERE id = $1`,
      [operation.channel_id],
    );
    const variant = await tx.query<{ schedule_state: string }>(
      "SELECT schedule_state FROM app.post_variants WHERE id = $1",
      [operation.variant_id],
    );
    const post = await tx.query<{ status: string; deleted_at: Date | null }>(
      `SELECT p.status, p.deleted_at FROM app.posts p JOIN app.post_variants v ON v.post_id = p.id AND v.workspace_id = p.workspace_id
         WHERE v.id = $1`,
      [operation.variant_id],
    );
    const live = variant.rows[0] !== undefined && post.rows[0] !== undefined;
    return {
      channel: channel.rows[0],
      targetLive:
        live &&
        variant.rows[0]?.schedule_state !== "settled" &&
        post.rows[0]?.status !== "archived" &&
        post.rows[0]?.deleted_at === null,
    };
  });
}

// A revoked grant has moved the channel unless a disable or disconnect moved it first, so the row follows the channel
// as it is now. Any other credential failure is the operator's to fix: the row waits and comes back, and is never
// failed for it.
async function afterRevocation(options: TurnOptions, held: Held): Promise<TurnResult> {
  const { channel, targetLive } = await readTarget(options.pool, held.operation);
  if (channel === undefined) return preflightMove(options.pool, held, { to: "failed" });
  const outcome = rereadOutcome({ channelState: channel.connection_state, targetLive });
  const waitSeconds = backoffSeconds(held.operation.attempt_count);
  return preflightMove(options.pool, held, outcome ?? { to: "retry_wait", waitSeconds });
}

function withoutAccess(
  options: TurnOptions,
  held: Held,
  kind: "retry" | "revoked" | "unavailable",
): Promise<TurnResult> {
  if (kind === "revoked") return afterRevocation(options, held);
  const { claim, operation } = held;
  options.logger.error(
    { event: "credential_unusable", operation: claim.id, workspace: claim.workspaceId, kind },
    "claimed operation has no usable credential",
  );
  const waitSeconds = backoffSeconds(operation.attempt_count);
  return preflightMove(options.pool, held, { to: "retry_wait", waitSeconds });
}

// Every write is fenced by the turn's token, so a turn whose lease moved writes nothing more and ends `lost`.
async function preflight(options: TurnOptions, held: Held): Promise<TurnResult> {
  const { pool, closing, now = () => performance.now() } = options;
  const { claim, operation, manifest, signal } = held;
  const lost: TurnResult = { kind: "lost", id: claim.id };
  if (closing.aborted) return handBack(pool, held, "closed");
  const target = await readTarget(pool, operation);
  if (signal.aborted) return lost;
  // A channel the worker cannot see is a removed target, so the operation fails.
  const { channel } = target;
  if (channel === undefined) return preflightMove(pool, held, { to: "failed" });
  const outcome = rereadOutcome({ channelState: channel.connection_state, targetLive: target.targetLive });
  if (outcome !== null) return preflightMove(pool, held, outcome);
  // A retired API sends nothing and spends no token: the row waits, visibly, until a live version is named.
  const clock = options.clock ?? (() => new Date());
  if (pastSunset(manifest, clock()))
    return preflightMove(pool, held, { to: "paused", reasonCode: "api_sunset" });
  if (closing.aborted) return handBack(pool, held, "closed");
  const denied = await takeLimits(pool, held, channel, "turn", () => signal.aborted || closing.aborted);
  if (signal.aborted) return lost;
  if (closing.aborted) return handBack(pool, held, "closed");
  if (denied !== null) return preflightMove(pool, held, denied);
  const adapter = options.adapters[manifest.id];
  if (adapter === undefined) {
    options.logger.error({ provider: manifest.id }, "claimed operation has no adapter");
    return preflightMove(pool, held, { to: "failed" });
  }
  const access = await accessOf(options.credentials, operation, channel.instance_host);
  if (signal.aborted) return lost;
  if (access.kind !== "ok") return withoutAccess(options, held, access.kind);
  const deps = {
    pool,
    logger: options.logger,
    owner: options.owner,
    adapter,
    account: access.account,
    credentials: options.credentials,
    fetch: options.fetchFor(manifest, channel.instance_host ?? undefined),
    now,
    clock,
    reconcileQueue: options.registry.queueNames(manifest.id).reconcile,
    closing,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  };
  return dispatch(deps, held, channel);
}
