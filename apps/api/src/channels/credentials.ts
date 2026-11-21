import { randomBytes, randomUUID } from "node:crypto";
import {
  adoptRefresh,
  type ChannelToken,
  channelTokenSchema,
  type RefreshClass,
  refreshClassOf,
  refreshFailureOutcome,
} from "@shoutory/core/channels";
import {
  type Aad,
  FORMAT_VERSION,
  open,
  SALT_BYTES,
  SealedSecret,
  type StoredSecret,
  seal,
} from "@shoutory/core/crypto";
import { pepperDigest } from "@shoutory/core/crypto/digest";
import type { KeyProvider } from "@shoutory/core/keys";
import { type TenantCtx, type TenantTx, withTenant } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import type { ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { z } from "zod";
import type { Logger } from "../logging/logger.js";

// The credential service (R537 (1)): the pure rules are in core, this file runs them. The lease, the attempt marker and
// the commit are definers in short transactions of their own; the provider is called between them with no transaction
// open (AGENTS 3.7, flows 1.3). Constants of R537 (9) and R540 (2): a 60 s lease, a 30 s provider timeout below it, a
// 5 minute refresh margin.
const LEASE_SECONDS = 60;
const PROVIDER_TIMEOUT_MS = 30_000;
const REFRESH_MARGIN_MS = 5 * 60_000;

/** The provider behind a channel: its adapter and the manifest's map of refresh error codes to classes. */
interface ChannelProvider {
  readonly adapter: ProviderAdapter;
  readonly manifest: { readonly refreshErrorMap: Readonly<Record<string, RefreshClass>> };
}

export interface CredentialServiceDeps {
  readonly pool: AppPool;
  readonly keys: KeyProvider;
  readonly pepper: SealedSecret;
  /** The egress client; the service gives every provider call its deadline. */
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly logger: Logger;
  readonly providers: Readonly<Record<string, ChannelProvider>>;
  readonly providerTimeoutMs?: number;
}

interface ConnectInput {
  /** The caller: a user with channels.manage or a job principal of the workspace. */
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
  /** The channel being reconnected, when there is one: another account on it is refused. */
  readonly reconnectChannelId?: string | undefined;
  readonly tokens: ChannelToken;
  readonly accessExpiresAt: Date;
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

/** A channel with no usable credential (none stored, or its salt was deleted). */
export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

// What each definer answers, parsed once where the row enters the service.
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

const aadOf = (workspaceId: string, channelId: string, generation: number): Aad => ({
  formatVersion: FORMAT_VERSION,
  scopeId: workspaceId,
  ownerId: channelId,
  credentialKind: "channel_token",
  generation,
});

const sealedParams = (s: StoredSecret) => [
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

// `SELECT * FROM app.<definer>($1, ..., $n)`; the name is always a literal of this file.
const callOf = (definer: string, params: unknown[]): [string, unknown[]] => [
  `SELECT * FROM app.${definer}(${params.map((_, index) => `$${index + 1}`).join(", ")})`,
  params,
];

/** An egress client that gives every provider call its deadline (below the lease, R537 (9)). */
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

  // The service's own transactions run as a job principal of the one workspace (R537 (2)).
  #asJob<T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const ctx: TenantCtx = { principalKind: "job", principalId: randomUUID(), workspaceIds: [workspaceId] };
    return withTenant(this.#deps.pool, ctx, fn);
  }

  async #openRow(workspaceId: string, channelId: string): Promise<OpenRow> {
    const found = await this.#asJob(workspaceId, (tx) =>
      tx.query(...callOf("credential_open", [workspaceId, channelId])),
    );
    if (!found.rows[0]) throw new CredentialError("the channel has no usable credential");
    return openRowSchema.parse(found.rows[0]);
  }

  #tokenOf(row: OpenRow, workspaceId: string, channelId: string): ChannelToken {
    const aad = aadOf(workspaceId, channelId, row.generation);
    const plain = open(storedOf(row), aad, this.#deps.keys, row.salt).expose();
    return channelTokenSchema.parse(JSON.parse(plain));
  }

  /** Stores the first or a new credential generation of a channel, in one transaction. */
  async connect(input: ConnectInput): Promise<{ channelId: string; generation: number }> {
    // The salt is ensured in its own statement first, so no row lock is held while it is drawn.
    const salted = await withTenant(this.#deps.pool, input.principal, (tx) =>
      tx.query("SELECT app.workspace_salt_ensure($1, $2) AS salt", [
        input.workspaceId,
        randomBytes(SALT_BYTES),
      ]),
    );
    const { salt } = saltSchema.parse(salted.rows[0]);
    return withTenant(this.#deps.pool, input.principal, async (tx) => {
      const { identity, audit } = input;
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
        ]),
      );
      const { channel_id: channelId, next_generation: generation } = connectedSchema.parse(made.rows[0]);
      await this.#put(tx, input, channelId, generation, salt);
      return { channelId, generation };
    });
  }

  async #put(tx: TenantTx, input: ConnectInput, channelId: string, generation: number, salt: Buffer) {
    const { snapshot, audit } = input;
    const aad = aadOf(input.workspaceId, channelId, generation);
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
      ]),
    );
  }

  /** The stored tokens, still sealed, with their generation and whether the refresh margin says a refresh is due. */
  async open(workspaceId: string, channelId: string) {
    const row = await this.#openRow(workspaceId, channelId);
    const token = this.#tokenOf(row, workspaceId, channelId);
    const expires = row.access_expires_at?.getTime();
    return {
      generation: row.generation,
      accessToken: new SealedSecret(token.access_token),
      refreshToken: token.refresh_token === undefined ? undefined : new SealedSecret(token.refresh_token),
      refreshDue: expires !== undefined && expires - this.#deps.now().getTime() <= REFRESH_MARGIN_MS,
    };
  }

  // Takes the lease and writes the attempt marker, in a transaction of its own that commits before the provider call.
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
    const aad = aadOf(workspaceId, channelId, generation);
    const stored = seal(JSON.stringify(adopted), aad, this.#deps.keys, row.salt);
    const expiresAt = new Date(this.#deps.now().getTime() + fresh.expiresInSeconds * 1000);
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
  // earlier attempt still unknown with the same digest is `refresh_token_rotated_unknown` (flows 1.3). The definer acts
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

  /** One refresh of a channel's token: lease, provider call, commit or failure, each in its own transaction. */
  async refresh(workspaceId: string, channelId: string): Promise<RefreshOutcome> {
    const first = await this.#openRow(workspaceId, channelId);
    const provider = this.#deps.providers[first.provider_id];
    const refreshCall = provider?.adapter.refresh;
    if (!provider || !refreshCall) return { kind: "config" };
    // With no refresh token there is nothing to send: no lease, no marker, no call, no state change.
    if (this.#tokenOf(first, workspaceId, channelId).refresh_token === undefined) {
      return { kind: "no_refresh_token" };
    }
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
    const result = await refreshCall.call(
      provider.adapter,
      { fetch: deadlineFetch(this.#deps.fetch, this.#deps.providerTimeoutMs), now: this.#deps.now },
      { refreshToken: new SealedSecret(current.refresh_token ?? "") },
    );
    return (
      (await this.#land(workspaceId, channelId, row, lease, current, result)) ??
      (await this.#endFailed(workspaceId, channelId, row, lease, result, provider))
    );
  }
}

export const createCredentialService = (deps: CredentialServiceDeps): CredentialService =>
  new CredentialService(deps);
