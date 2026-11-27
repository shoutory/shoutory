import { randomBytes, randomUUID } from "node:crypto";
import {
  adoptRefresh,
  type ChannelToken,
  channelTokenSchema,
  refreshClassOf,
  refreshFailureOutcome,
} from "@shoutory/core/channels";
import {
  type Aad,
  EnvelopeError,
  FORMAT_VERSION,
  open,
  SALT_BYTES,
  SealedSecret,
  type StoredSecret,
  seal,
} from "@shoutory/core/crypto";
import { pepperDigest } from "@shoutory/core/crypto/digest";
import { KeyError, type KeyProvider } from "@shoutory/core/keys";
import { type TenantCtx, type TenantTx, withTenant } from "@shoutory/db/context";
import { withSystem } from "@shoutory/db/context/system";
import { withAdvisoryLock } from "@shoutory/db/locks";
import type { AppPool } from "@shoutory/db/pool";
import type { AdapterContext, AdapterMap, ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { Registry } from "@shoutory/provider-sdk/registry";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { z } from "zod";
import type { Logger } from "../logging/logger.js";
import { readProviderApp } from "./provider-app.js";

// The provider is called between short transactions with none open, and its timeout stays below the lease.
const LEASE_SECONDS = 60;
const PROVIDER_TIMEOUT_MS = 30_000;
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface ChannelProvider {
  readonly adapter: ProviderAdapter;
  readonly manifest: Manifest;
}

export const channelProvidersOf = (
  registry: Registry,
  adapters: AdapterMap,
): Record<string, ChannelProvider> =>
  Object.fromEntries(
    registry.manifests.flatMap((manifest) => {
      const adapter = adapters[manifest.id];
      return adapter === undefined ? [] : [[manifest.id, { adapter, manifest }]];
    }),
  );

export interface CredentialServiceDeps {
  readonly pool: AppPool;
  readonly keys: KeyProvider;
  readonly pepper: SealedSecret;
  readonly fetch: typeof fetch;
  /** The egress client bound to a channel's own instance host; absent, every call uses `fetch`. */
  readonly fetchFor?: ((manifest: Manifest, instanceHost: string | undefined) => typeof fetch) | undefined;
  readonly resolveTxt?: AdapterContext["resolveTxt"];
  readonly now: () => Date;
  readonly logger: Logger;
  readonly providers: Readonly<Record<string, ChannelProvider>>;
  readonly providerTimeoutMs?: number;
}

interface ConnectInput {
  readonly principal: TenantCtx;
  readonly workspaceId: string;
  readonly identity: {
    readonly providerId: string;
    readonly accountKind: string;
    readonly providerAccountId: string;
    readonly displayName: string;
    readonly instanceHost?: string | undefined;
    readonly handle?: string | undefined;
    readonly avatar?: string | undefined;
  };
  /** Another account on a reconnected channel is refused. */
  readonly reconnectChannelId?: string | undefined;
  readonly tokens: ChannelToken;
  /** What the value is: an authorized token, a bot token held on a challenge, or a pasted webhook URL. */
  readonly credential?: { readonly kind: ChannelKind; readonly takenChallengeId?: string | undefined };
  /** Null for a token the provider never expires; it is never due for a refresh. */
  readonly accessExpiresAt: Date | null;
  readonly refreshExpiresAt?: Date | undefined;
  readonly snapshot: {
    readonly manifestDigest: string;
    readonly apiVersion: string;
    readonly sunsetAt: Date | null;
    readonly capabilities: object;
    readonly limits: object;
  };
  readonly audit: { readonly requestId: string; readonly ipHmac: Buffer | null };
}

type RefreshOutcome =
  | { readonly kind: "refreshed"; readonly generation: number }
  | { readonly kind: "lost_race" }
  | { readonly kind: "retry_later"; readonly refreshClass: "transient" | "rate_limited" }
  | { readonly kind: "config" }
  | { readonly kind: "no_refresh_token" }
  | { readonly kind: "needs_reconnect"; readonly reason: string };

const usableOf = (opened: { accessToken: SealedSecret; dpopKey: SealedSecret | undefined }): Usable => ({
  kind: "ok",
  accessToken: opened.accessToken,
  ...(opened.dpopKey === undefined ? {} : { dpopKey: opened.dpopKey }),
});

export type Usable =
  | { readonly kind: "ok"; readonly accessToken: SealedSecret; readonly dpopKey?: SealedSecret }
  | { readonly kind: "retry" }
  | { readonly kind: "revoked" }
  | { readonly kind: "unavailable" };

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

const CHANNEL_KINDS = ["channel_token", "bot_token", "webhook_url"] as const;
type ChannelKind = (typeof CHANNEL_KINDS)[number];

const bytes = z.instanceof(Buffer);
const int = z.number().int();
const openRowSchema = z.object({
  generation: int,
  format_version: int,
  key_id: z.string(),
  iv: bytes,
  ciphertext: bytes,
  auth_tag: bytes,
  wrap_iv: bytes,
  wrap_tag: bytes,
  wrapped_dek: bytes,
  access_expires_at: z.date().nullable(),
  refresh_expires_at: z.date().nullable(),
  refresh_token_digest: z.string().nullable(),
  salt: bytes,
  provider_id: z.string(),
  kind: z.enum(CHANNEL_KINDS),
});
type OpenRow = z.infer<typeof openRowSchema>;

const leaseSchema = z.object({
  won: z.boolean(),
  fencing: int,
  generation: int,
  refresh_token_digest: z.string(),
  prior_attempt_digest: z.string().nullable(),
  prior_attempt_outcome: z.string().nullable(),
});
type Lease = z.infer<typeof leaseSchema>;

const connectedSchema = z.object({ channel_id: z.string(), next_generation: int });
const saltSchema = z.object({ salt: bytes });
const landedSchema = z.object({ landed: z.boolean() });
const failedSchema = z.object({ credential_refresh_fail: z.enum(["applied", "changed"]) });

const aadOf = (
  workspaceId: string,
  channelId: string,
  generation: number,
  credentialKind: ChannelKind = "channel_token",
): Aad => ({
  formatVersion: FORMAT_VERSION,
  scopeId: workspaceId,
  ownerId: channelId,
  credentialKind,
  generation,
});

// Two first callers end with one salt: the loser receives the winner's.
export async function ensureSalt(tx: TenantTx, workspaceId: string): Promise<Buffer> {
  const salted = await tx.query("SELECT app.workspace_salt_ensure($1, $2) AS salt", [
    workspaceId,
    randomBytes(SALT_BYTES),
  ]);
  return saltSchema.parse(salted.rows[0]).salt;
}

export const expiryOf = (now: Date, seconds: number | undefined): Date | null =>
  seconds === undefined ? null : new Date(now.getTime() + seconds * 1000);

export const sealedParams = (s: StoredSecret) => [
  s.formatVersion,
  s.keyId,
  s.iv,
  s.ciphertext,
  s.tag,
  s.wrapIv,
  s.wrapTag,
  s.wrappedDek,
];

const storedOf = (row: OpenRow): StoredSecret => ({
  formatVersion: row.format_version,
  keyId: row.key_id,
  iv: row.iv,
  ciphertext: row.ciphertext,
  tag: row.auth_tag,
  wrapIv: row.wrap_iv,
  wrapTag: row.wrap_tag,
  wrappedDek: row.wrapped_dek,
});

// The definer name is always a literal of this file, never input.
const callOf = (definer: string, params: unknown[]): [string, unknown[]] => [
  `SELECT * FROM app.${definer}(${params.map((_, index) => `$${index + 1}`).join(", ")})`,
  params,
];

async function readOpenRow(pool: AppPool, workspaceId: string, channelId: string): Promise<OpenRow> {
  const ctx: TenantCtx = { principalKind: "job", principalId: randomUUID(), workspaceIds: [workspaceId] };
  const found = await withTenant(pool, ctx, (tx) =>
    tx.query(...callOf("credential_open", [workspaceId, channelId])),
  );
  if (!found.rows[0]) throw new CredentialError("the channel has no usable credential");
  return openRowSchema.parse(found.rows[0]);
}

function tokenOfRow(keys: KeyProvider, row: OpenRow, workspaceId: string, channelId: string): ChannelToken {
  const aad = aadOf(workspaceId, channelId, row.generation, row.kind);
  return channelTokenSchema.parse(JSON.parse(open(storedOf(row), aad, keys, row.salt).expose()));
}

export const deadlineFetch =
  (egress: typeof fetch, timeoutMs = PROVIDER_TIMEOUT_MS): typeof fetch =>
  (input, init) =>
    egress(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });

export class CredentialService {
  readonly #deps: CredentialServiceDeps;

  constructor(deps: CredentialServiceDeps) {
    this.#deps = deps;
  }

  #digestOf(token: ChannelToken): string | null {
    return token.refresh_token === undefined
      ? null
      : pepperDigest(this.#deps.pepper, "refresh_token", token.refresh_token);
  }

  #asJob<T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const ctx: TenantCtx = { principalKind: "job", principalId: randomUUID(), workspaceIds: [workspaceId] };
    return withTenant(this.#deps.pool, ctx, fn);
  }

  // The two facts of a channel a provider call is made with besides its token.
  async channelFactsOf(
    workspaceId: string,
    channelId: string,
  ): Promise<{ instanceHost?: string; providerAccountId?: string }> {
    const found = await this.#asJob(workspaceId, (tx) =>
      tx.query(
        "SELECT instance_host, provider_account_id FROM app.channels WHERE workspace_id = $1 AND id = $2",
        [workspaceId, channelId],
      ),
    );
    const row = z
      .object({ instance_host: z.string().nullable(), provider_account_id: z.string().nullable() })
      .optional()
      .parse(found.rows[0]);
    return {
      ...(row?.instance_host == null ? {} : { instanceHost: row.instance_host }),
      ...(row?.provider_account_id == null ? {} : { providerAccountId: row.provider_account_id }),
    };
  }

  // Only a provider whose host is the channel's own reads the host; every other keeps its manifest's hosts.
  async egressFor(
    workspaceId: string,
    channelId: string,
    provider: ChannelProvider,
  ): Promise<{ fetch: typeof fetch; resolveTxt: AdapterContext["resolveTxt"]; instanceHost?: string }> {
    const host =
      provider.manifest.egressHostSource === "channel"
        ? (await this.channelFactsOf(workspaceId, channelId)).instanceHost
        : undefined;
    const egress = this.#deps.fetchFor?.(provider.manifest, host) ?? this.#deps.fetch;
    return {
      fetch: deadlineFetch(egress, this.#deps.providerTimeoutMs),
      resolveTxt: this.#deps.resolveTxt,
      ...(host === undefined ? {} : { instanceHost: host }),
    };
  }

  #openRow(workspaceId: string, channelId: string): Promise<OpenRow> {
    return readOpenRow(this.#deps.pool, workspaceId, channelId);
  }

  #tokenOf(row: OpenRow, workspaceId: string, channelId: string): ChannelToken {
    return tokenOfRow(this.#deps.keys, row, workspaceId, channelId);
  }

  async connect(input: ConnectInput): Promise<{ channelId: string; generation: number }> {
    // The salt is ensured in its own statement first, so no row lock is held while it is drawn.
    const salt = await withTenant(this.#deps.pool, input.principal, (tx) =>
      ensureSalt(tx, input.workspaceId),
    );
    return withTenant(this.#deps.pool, input.principal, async (tx) => {
      const { identity, audit } = input;
      const store = async () => {
        const made = await tx.query<{ channel_id: string; next_generation: number }>(
          ...callOf("channel_connect", [
            input.workspaceId,
            identity.providerId,
            identity.accountKind,
            identity.providerAccountId,
            identity.instanceHost ?? null,
            identity.displayName,
            identity.handle ?? null,
            identity.avatar ?? null,
            input.reconnectChannelId ?? null,
            audit.requestId,
            audit.ipHmac,
            input.credential?.takenChallengeId ?? null,
          ]),
        );
        const { channel_id: channelId, next_generation: generation } = connectedSchema.parse(made.rows[0]);
        await this.#put(tx, input, channelId, generation, salt);
        return { channelId, generation };
      };
      // A reconnect names its channel, so two of them are ordered by its advisory lock (the first lock in the lock order).
      // A connect that names none takes no advisory lock, also when its identity turns out to match an existing channel
      // and reuses it: it relies on the identity key and the channel row lock.
      return input.reconnectChannelId === undefined
        ? store()
        : withAdvisoryLock(tx, "channel", store, input.reconnectChannelId);
    });
  }

  async #put(tx: TenantTx, input: ConnectInput, channelId: string, generation: number, salt: Buffer) {
    const { snapshot, audit } = input;
    const kind = input.credential?.kind ?? "channel_token";
    const aad = aadOf(input.workspaceId, channelId, generation, kind);
    const stored = seal(JSON.stringify(input.tokens), aad, this.#deps.keys, salt);
    await tx.query(
      ...callOf("credential_put", [
        input.workspaceId,
        channelId,
        generation - 1,
        ...sealedParams(stored),
        input.accessExpiresAt,
        input.refreshExpiresAt ?? null,
        this.#digestOf(input.tokens),
        snapshot.manifestDigest,
        snapshot.apiVersion,
        snapshot.sunsetAt,
        JSON.stringify(snapshot.capabilities),
        JSON.stringify(snapshot.limits),
        audit.requestId,
        audit.ipHmac,
        kind,
        input.credential?.takenChallengeId ?? null,
      ]),
    );
  }

  async open(workspaceId: string, channelId: string) {
    const row = await this.#openRow(workspaceId, channelId);
    const token = this.#tokenOf(row, workspaceId, channelId);
    const left =
      row.access_expires_at === null
        ? undefined
        : row.access_expires_at.getTime() - this.#deps.now().getTime();
    return {
      generation: row.generation,
      accessToken: new SealedSecret(token.access_token),
      refreshToken: token.refresh_token === undefined ? undefined : new SealedSecret(token.refresh_token),
      dpopKey:
        token.dpop_private_jwk === undefined
          ? undefined
          : new SealedSecret(JSON.stringify(token.dpop_private_jwk)),
      issuer: token.issuer,
      refreshDue: left !== undefined && left <= REFRESH_MARGIN_MS,
      // A token with no expiry lives until the provider says otherwise.
      alive: left === undefined || left > 0,
    };
  }

  // The token a call is made with: refreshed first when it is due. A refresh that failed for a while leaves the stored
  // token in use while it lives; `revoked` is a confirmed revocation, and the channel has already moved.
  async usable(workspaceId: string, channelId: string): Promise<Usable> {
    try {
      const opened = await this.open(workspaceId, channelId);
      if (!opened.refreshDue) return usableOf(opened);
      const outcome = await this.refresh(workspaceId, channelId);
      if (outcome.kind === "needs_reconnect") return { kind: "revoked" };
      const current =
        outcome.kind === "refreshed" || outcome.kind === "lost_race"
          ? await this.open(workspaceId, channelId)
          : opened;
      return current.alive ? usableOf(current) : { kind: "retry" };
    } catch (error) {
      // A key that is not loaded may come back; a credential that is missing or cannot be opened will not.
      if (error instanceof KeyError) return { kind: "retry" };
      if (error instanceof CredentialError || error instanceof EnvelopeError) return { kind: "unavailable" };
      throw error;
    }
  }

  // A provider answered that the grant is gone: the credential is checked again before the channel moves. With a
  // refresh token the refresh is the check; without one the provider's credential check is, and only its own
  // revocation answer moves the channel. A credential that cannot be opened confirms nothing.
  async confirmRevoked(workspaceId: string, channelId: string): Promise<boolean> {
    try {
      return await this.#confirmRevoked(workspaceId, channelId);
    } catch (error) {
      if (error instanceof KeyError || error instanceof CredentialError || error instanceof EnvelopeError) {
        this.#deps.logger.error(
          { event: "credential_unusable", workspaceId, channelId, error: error.name },
          "a revocation could not be checked",
        );
        return false;
      }
      throw error;
    }
  }

  async #confirmRevoked(workspaceId: string, channelId: string): Promise<boolean> {
    const row = await this.#openRow(workspaceId, channelId);
    const provider = this.#deps.providers[row.provider_id];
    if (provider === undefined) return false;
    const token = this.#tokenOf(row, workspaceId, channelId);
    if (token.refresh_token !== undefined) {
      return (await this.refresh(workspaceId, channelId)).kind === "needs_reconnect";
    }
    const egress = await this.egressFor(workspaceId, channelId, provider);
    const result = await provider.adapter.inspect(
      { fetch: egress.fetch, now: this.#deps.now, resolveTxt: egress.resolveTxt },
      {
        accessToken: new SealedSecret(token.access_token),
        ...(egress.instanceHost === undefined ? {} : { instanceHost: egress.instanceHost }),
      },
    );
    if (result.ok || result.errorClass !== "auth_revoked") return false;
    await this.#asJob(workspaceId, (tx) =>
      tx.query(...callOf("channel_revoke_confirmed", [workspaceId, channelId])),
    );
    return true;
  }

  // Commits before the provider call, so the attempt marker survives a crash during it.
  async #beginLease(workspaceId: string, channelId: string): Promise<Lease> {
    const owner = `service-${randomUUID().slice(0, 8)}`;
    const begun = await this.#asJob(workspaceId, (tx) =>
      tx.query(...callOf("credential_refresh_begin", [workspaceId, channelId, owner, LEASE_SECONDS])),
    );
    if (!begun.rows[0]) throw new CredentialError("the channel has no usable credential");
    return leaseSchema.parse(begun.rows[0]);
  }

  // Lands a refresh the provider answered: the new generation is sealed with the next generation in its AAD, and the
  // commit lands only while the digest and the generation it started from are unchanged.
  async #land(
    workspaceId: string,
    channelId: string,
    row: OpenRow,
    lease: Lease,
    current: ChannelToken,
    result: ProviderResult,
  ): Promise<RefreshOutcome | undefined> {
    const fresh = result.ok ? result.credential : undefined;
    const adopted = adoptRefresh(current, {
      access_token: fresh?.accessToken.expose() ?? "",
      refresh_token: fresh?.refreshToken?.expose(),
    });
    if (!fresh || !adopted) return undefined;
    const generation = row.generation + 1;
    const aad = aadOf(workspaceId, channelId, generation, row.kind);
    const stored = seal(JSON.stringify(adopted), aad, this.#deps.keys, row.salt);
    const expiresAt = expiryOf(this.#deps.now(), fresh.expiresInSeconds);
    const landed = await this.#asJob(workspaceId, (tx) =>
      tx.query(
        ...callOf("credential_refresh_commit", [
          workspaceId,
          channelId,
          row.refresh_token_digest,
          row.generation,
          lease.fencing,
          ...sealedParams(stored),
          expiresAt,
          row.refresh_expires_at,
          this.#digestOf(adopted),
        ]),
      ),
    );
    return landedSchema.parse(landed.rows[0]).landed
      ? { kind: "refreshed", generation }
      : { kind: "lost_race" };
  }

  // Ends a failed attempt. The class follows the adapter's result and the manifest's map; a revocation that follows an
  // earlier attempt still unknown with the same digest is `refresh_token_rotated_unknown`. The definer acts
  // only while the digest is the one the attempt started from, so a competing commit is never overridden.
  async #endFailed(
    workspaceId: string,
    channelId: string,
    row: OpenRow,
    lease: Lease,
    result: ProviderResult,
    provider: ChannelProvider,
  ): Promise<RefreshOutcome> {
    // An answer that was ok but unusable may have spent a rotating token: it is unknown, like a cut-off one.
    const klass = refreshClassOf(
      result.ok ? { errorClass: "unknown" } : result,
      provider.manifest.refreshErrorMap,
    );
    const earlier =
      lease.prior_attempt_outcome === "unknown" && lease.prior_attempt_digest === lease.refresh_token_digest;
    const outcome = refreshFailureOutcome(klass, earlier);
    const ended = await this.#asJob(workspaceId, (tx) =>
      tx.query("SELECT app.credential_refresh_fail($1, $2, $3, $4, $5, $6)", [
        workspaceId,
        channelId,
        row.refresh_token_digest,
        lease.fencing,
        outcome.marker,
        outcome.stateReason,
      ]),
    );
    if (failedSchema.parse(ended.rows[0]).credential_refresh_fail === "changed") return { kind: "lost_race" };
    if (klass === "config") {
      // The provider's code is never echoed: the alert names the channel only.
      this.#deps.logger.warn(
        { event: "credential_refresh_config", workspaceId, channelId },
        "token refresh failed for a reason the manifest does not map",
      );
      return { kind: "config" };
    }
    if (outcome.stateReason !== null) return { kind: "needs_reconnect", reason: outcome.stateReason };
    return { kind: "retry_later", refreshClass: klass === "rate_limited" ? "rate_limited" : "transient" };
  }

  async #release(workspaceId: string, channelId: string, lease: Lease): Promise<void> {
    await this.#asJob(workspaceId, (tx) =>
      tx.query(
        ...callOf("credential_refresh_fail", [
          workspaceId,
          channelId,
          lease.refresh_token_digest,
          lease.fencing,
          "failed",
          null,
        ]),
      ),
    );
  }

  // A provider that signs for the whole instance needs its app to refresh a token.
  async #providerAppOf(workspaceId: string, providerId: string, provider: ChannelProvider) {
    if (provider.adapter.connect?.appKind !== "provider") return undefined;
    return this.#asJob(workspaceId, (tx) => readProviderApp(tx, this.#deps.keys, providerId, null));
  }

  async refresh(workspaceId: string, channelId: string): Promise<RefreshOutcome> {
    const first = await this.#openRow(workspaceId, channelId);
    const provider = this.#deps.providers[first.provider_id];
    const refreshCall = provider?.adapter.refresh;
    if (!provider || !refreshCall) return { kind: "config" };
    if (this.#tokenOf(first, workspaceId, channelId).refresh_token === undefined) {
      return { kind: "no_refresh_token" };
    }
    // Resolved before the lease, so a failure here leaves no attempt marker behind.
    const egress = await this.egressFor(workspaceId, channelId, provider);
    const lease = await this.#beginLease(workspaceId, channelId);
    if (!lease.won) return { kind: "lost_race" };
    // A commit between the open and the lease moved the generation: this refresh began from a token that is gone. The
    // lease is released (the attempt is `failed`, nothing was sent) and the caller reads the credential again.
    if (lease.generation !== first.generation || lease.refresh_token_digest !== first.refresh_token_digest) {
      await this.#release(workspaceId, channelId, lease);
      return { kind: "lost_race" };
    }
    const row = first;
    const current = this.#tokenOf(row, workspaceId, channelId);
    const app = await this.#providerAppOf(workspaceId, first.provider_id, provider);
    const result = await refreshCall.call(
      provider.adapter,
      { fetch: egress.fetch, now: this.#deps.now, resolveTxt: egress.resolveTxt },
      {
        refreshToken: new SealedSecret(current.refresh_token ?? ""),
        ...(app === undefined ? {} : { app }),
        ...(current.dpop_private_jwk === undefined
          ? {}
          : { dpopKey: new SealedSecret(JSON.stringify(current.dpop_private_jwk)) }),
        ...(current.issuer === undefined ? {} : { issuer: current.issuer }),
        ...(egress.instanceHost === undefined ? {} : { instanceHost: egress.instanceHost }),
      },
    );
    return (
      (await this.#land(workspaceId, channelId, row, lease, current, result)) ??
      (await this.#endFailed(workspaceId, channelId, row, lease, result, provider))
    );
  }
}

export const createCredentialService = (deps: CredentialServiceDeps): CredentialService =>
  new CredentialService(deps);

// A token due within this margin is refreshed by the sweep, ahead of the 5-minute margin of a call.
const SWEEP_MARGIN_SECONDS = 900;
const dueSchema = z.object({ workspace_id: z.string(), channel_id: z.string() });

export interface SweepDeps {
  readonly pool: AppPool;
  readonly credentials: CredentialService;
  readonly logger: Logger;
  readonly limit: number;
}

export async function sweepCredentials({ pool, credentials, logger, limit }: SweepDeps): Promise<void> {
  // A passed token with nothing to refresh it can send nothing more, so its channel waits for a reconnect.
  await withSystem(pool, "credential_refresh", (tx) =>
    tx.query("SELECT app.channels_expire_tokens($1)", [limit]),
  );
  const due = await withSystem(pool, "credential_refresh", (tx) =>
    tx.query("SELECT * FROM app.due_token_refreshes($1, $2)", [limit, SWEEP_MARGIN_SECONDS]),
  );
  for (const { workspace_id: workspaceId, channel_id: channelId } of due.rows.map((row) =>
    dueSchema.parse(row),
  )) {
    try {
      await credentials.refresh(workspaceId, channelId);
    } catch (error) {
      // One channel that cannot be refreshed never stops the others; the alert names the channel and the error
      // class only, never the message, which may quote what the provider sent.
      if (!(error instanceof Error)) throw error;
      logger.error(
        { event: "credential_refresh_failed", workspaceId, channelId, error: error.name },
        "a token refresh failed",
      );
    }
  }
}
