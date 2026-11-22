import {
  digestOfState,
  flowObjectSchema,
  issuerAccepted,
  newState,
  pkcePair,
  providerErrorText,
} from "@shoutory/core/connect/flow";
import { type Aad, FORMAT_VERSION, open, SealedSecret, seal } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import { type TenantCtx, type TenantTx, withTenant } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import type { ConnectAdapter } from "@shoutory/provider-sdk/adapter";
import type { AccountIdentity, RefreshedCredential } from "@shoutory/provider-sdk/result";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import { z } from "zod";
import { Refusal } from "../errors/refusal.js";
import type { Logger } from "../logging/logger.js";
import { definerRefusal } from "../routes/definer-refusal.js";
import { type CredentialService, deadlineFetch, ensureSalt, sealedParams } from "./credentials.js";
import type { HealthChecker, HealthProvider } from "./health.js";

// The OAuth connect. `start` seals the PKCE verifier under the flow id and stores the flow through its
// definer; it makes no outbound call, so it runs in the route's own transaction. `finish` answers the callback: it takes
// the flow, checks the issuer, exchanges the code and reads the account through the adapter's egress fetch with no
// transaction open, stores the channel through the credential service and looks at its health twice before it shows it.

export interface ConnectDeps {
  readonly pool: AppPool;
  readonly keys: KeyProvider;
  /** The egress client; the adapter's calls get a deadline from it. */
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  /** The exact origin the web app is served from: the redirect URI of a provider is built on it. */
  readonly publicOrigin: string;
  readonly providers: Readonly<Record<string, HealthProvider>>;
  readonly credentials: CredentialService;
  readonly checker: HealthChecker;
  readonly logger: Logger;
}

/** The redirect URI the provider sends the person back to; an instance host rides in its query. */
function redirectUriOf(publicOrigin: string, providerId: string, instanceHost?: string): string {
  const base = `${publicOrigin}/api/v1/connect/${providerId}/callback`;
  if (instanceHost === undefined) return base;
  return `${base}?${new URLSearchParams({ instance_host: instanceHost })}`;
}

/** The AAD of a flow object: the workspace is the scope and the flow id the owner (generation 1). */
const flowAadOf = (workspaceId: string, flowId: string): Aad => ({
  formatVersion: FORMAT_VERSION,
  scopeId: workspaceId,
  ownerId: flowId,
  credentialKind: "oauth_flow",
  generation: 1,
});

export interface StartInput {
  readonly workspaceId: string;
  readonly providerId: string;
  readonly instanceHost?: string | undefined;
  /** The channel being reconnected, when there is one. */
  readonly channelId?: string | undefined;
}

/** The parameters of a provider's callback that are read; anything else a provider adds is ignored. */
interface CallbackQuery {
  readonly code?: string | undefined;
  readonly state?: string | undefined;
  readonly iss?: string | undefined;
  readonly error?: string | undefined;
  readonly error_description?: string | undefined;
  readonly instance_host?: string | undefined;
}

export interface FinishInput {
  readonly userId: string;
  readonly providerId: string;
  readonly query: CallbackQuery;
  readonly requestId: string;
  readonly ipHmac: Buffer;
}

/** What a callback came to: a stored channel, a flow that must be started again, or a refusal. */
export type ConnectOutcome =
  | { readonly kind: "connected"; readonly channelId: string }
  | { readonly kind: "start_again" | "refused" | "failed" }
  | { readonly kind: "provider_error"; readonly message: string };

const bytes = z.instanceof(Buffer);
const flowRowSchema = z.object({
  flow_id: z.string(),
  workspace_id: z.string(),
  channel_id: z.string().nullable(),
  instance_host: z.string().nullable(),
  format_version: z.number().int(),
  key_id: z.string(),
  iv: bytes,
  ciphertext: bytes,
  auth_tag: bytes,
  wrap_iv: bytes,
  wrap_tag: bytes,
  wrapped_dek: bytes,
});
type FlowRow = z.infer<typeof flowRowSchema>;

/** What a provider handed over for a code: the tokens and the account they belong to. */
interface Granted {
  readonly credential: RefreshedCredential;
  readonly identity: AccountIdentity;
}

/** A provider's refusal of the code or of the account read: the step and the adapter's error class. */
interface GrantFailure {
  readonly step: string;
  readonly errorClass: string;
}

const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const PUT_FLOW =
  "SELECT app.oauth_flow_put($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)";
const TAKE_FLOW = "SELECT * FROM app.oauth_flow_take($1, $2, $3, $4, $5)";
const RECORD_HEALTH = "SELECT app.channel_health_record($1, $2, $3, $4, $5, $6, $7, $8)";
// A spent or stale flow is started again; every other refusal of the take is plain refused.
const START_AGAIN = new Set(["consumed", "expired"]);

export class ConnectService {
  readonly #deps: ConnectDeps;

  constructor(deps: ConnectDeps) {
    this.#deps = deps;
  }

  // Own keys only: a provider id from the path is never looked up on the prototype.
  #providerOf(providerId: string): HealthProvider | undefined {
    return Object.hasOwn(this.#deps.providers, providerId) ? this.#deps.providers[providerId] : undefined;
  }

  /** Stores a new flow for the caller and answers the URL the person is sent to. */
  async start(tx: TenantTx, input: StartInput): Promise<string> {
    const connect = this.#providerOf(input.providerId)?.adapter.connect;
    if (!connect) throw new Refusal("not_found", "no connect for the provider");
    const { state, digest } = newState();
    const { verifier, challenge } = pkcePair();
    const salt = await ensureSalt(tx, input.workspaceId);
    // The flow id is read first: the owner the sealed object is bound to is the id the row will carry.
    const flowId = String((await tx.query("SELECT uuidv7() AS id")).rows[0]?.id);
    const aad = flowAadOf(input.workspaceId, flowId);
    const stored = seal(JSON.stringify({ code_verifier: verifier }), aad, this.#deps.keys, salt);
    try {
      await tx.query(PUT_FLOW, [
        flowId,
        input.workspaceId,
        input.providerId,
        digest,
        input.channelId ?? null,
        input.instanceHost ?? null,
        ...sealedParams(stored),
        null,
      ]);
    } catch (error) {
      throw definerRefusal(error) ?? error;
    }
    return connect.authorize({
      state,
      codeChallenge: challenge,
      redirectUri: redirectUriOf(this.#deps.publicOrigin, input.providerId, input.instanceHost),
      ...(input.instanceHost === undefined ? {} : { instanceHost: input.instanceHost }),
    });
  }

  /** Answers a callback: the flow is taken first and spent whatever follows; a provider's own error ends it there. */
  async finish(input: FinishInput): Promise<ConnectOutcome> {
    const provider = this.#providerOf(input.providerId);
    const connect = provider?.adapter.connect;
    if (!provider || !connect) return { kind: "refused" };
    const principal = { principalKind: "user", principalId: input.userId } as const;
    const taken = await this.#take(principal, input);
    if ("kind" in taken) return taken;
    const { query } = input;
    if (query.error !== undefined) {
      return { kind: "provider_error", message: providerErrorText(query.error_description ?? query.error) };
    }
    if (query.code === undefined) return this.#failed(input.providerId, "callback", "none");
    if (!issuerAccepted(connect.issuer, query.iss)) return { kind: "refused" };
    const progress = { step: "unseal" };
    try {
      const granted = await this.#grant(principal, taken, { connect, code: query.code, input, progress });
      if (!("credential" in granted)) return this.#failed(input.providerId, granted.step, granted.errorClass);
      progress.step = "store";
      return await this.#store(principal, taken, { provider, input, granted });
    } catch (error) {
      // After the take the flow is spent, so nothing thrown from here is a fault of the request: a flow object that cannot
      // be opened (a rotated key, a damaged row) and any other failure alike end as a failed connect.
      return this.#failed(input.providerId, progress.step, errorClassOf(error));
    }
  }

  // One structured line per failed connect: the provider, the step and the error class, never a value of the flow.
  #failed(providerId: string, step: string, errorClass: string): ConnectOutcome {
    this.#deps.logger.warn({ event: "connect_failed", providerId, step, errorClass }, "connect failed");
    return { kind: "failed" };
  }

  // The one step of the callback that may refuse: the flow is spent here, whatever comes next.
  async #take(principal: TenantCtx, input: FinishInput): Promise<FlowRow | ConnectOutcome> {
    const { query } = input;
    const answer = await withTenant(this.#deps.pool, principal, (tx) =>
      tx.query(TAKE_FLOW, [
        digestOfState(query.state ?? ""),
        input.providerId,
        query.instance_host ?? null,
        input.requestId,
        input.ipHmac,
      ]),
    );
    const outcome = String(answer.rows[0]?.outcome);
    if (outcome !== "ok") return { kind: START_AGAIN.has(outcome) ? "start_again" : "refused" };
    return flowRowSchema.parse(answer.rows[0]);
  }

  // The verifier the flow sealed, opened with the workspace salt and the flow id as the owner.
  async #verifierOf(principal: TenantCtx, flow: FlowRow): Promise<string> {
    const salt = await withTenant(this.#deps.pool, principal, (tx) => ensureSalt(tx, flow.workspace_id));
    const stored = {
      formatVersion: flow.format_version,
      keyId: flow.key_id,
      iv: flow.iv,
      ciphertext: flow.ciphertext,
      tag: flow.auth_tag,
      wrapIv: flow.wrap_iv,
      wrapTag: flow.wrap_tag,
      wrappedDek: flow.wrapped_dek,
    };
    const plain = open(stored, flowAadOf(flow.workspace_id, flow.flow_id), this.#deps.keys, salt).expose();
    return flowObjectSchema.parse(JSON.parse(plain)).code_verifier;
  }

  // The code exchange and the account read, outside any transaction: nothing here holds a database connection.
  async #grant(
    principal: TenantCtx,
    flow: FlowRow,
    step: { connect: ConnectAdapter; code: string; input: FinishInput; progress: { step: string } },
  ): Promise<Granted | GrantFailure> {
    const { progress } = step;
    const context = { fetch: deadlineFetch(this.#deps.fetch), now: this.#deps.now };
    const host = flow.instance_host ?? undefined;
    const hostPart = host === undefined ? {} : { instanceHost: host };
    const codeVerifier = new SealedSecret(await this.#verifierOf(principal, flow));
    progress.step = "exchange";
    const exchanged = await step.connect.exchangeCode(context, {
      code: step.code,
      codeVerifier,
      redirectUri: redirectUriOf(this.#deps.publicOrigin, step.input.providerId, host),
      ...hostPart,
    });
    if (!exchanged.ok || !exchanged.credential) {
      return { step: "exchange", errorClass: exchanged.errorClass ?? "none" };
    }
    progress.step = "identity";
    const accessToken = exchanged.credential.accessToken;
    const who = await step.connect.identity(context, { accessToken, ...hostPart });
    if (!who.ok || !who.identity) return { step: "identity", errorClass: who.errorClass ?? "none" };
    return { credential: exchanged.credential, identity: who.identity };
  }

  // The channel and its first credential, then its health looked at before it is shown.
  async #store(
    principal: TenantCtx,
    flow: FlowRow,
    step: { provider: HealthProvider; input: FinishInput; granted: Granted },
  ): Promise<ConnectOutcome> {
    const { accessToken, refreshToken, expiresInSeconds } = step.granted.credential;
    const now = this.#deps.now();
    try {
      const { channelId } = await this.#deps.credentials.connect({
        principal,
        workspaceId: flow.workspace_id,
        identity: {
          providerId: step.input.providerId,
          ...step.granted.identity,
          instanceHost: flow.instance_host ?? undefined,
        },
        reconnectChannelId: flow.channel_id ?? undefined,
        tokens: {
          access_token: accessToken.expose(),
          ...(refreshToken === undefined ? {} : { refresh_token: refreshToken.expose() }),
        },
        accessExpiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
        snapshot: snapshotOf(step.provider.manifest, now),
        audit: { requestId: step.input.requestId, ipHmac: step.input.ipHmac },
      });
      await this.#recordHealthOnce(principal, flow.workspace_id, channelId, step.provider);
      return { kind: "connected", channelId };
    } catch (error) {
      // The account is not the channel's (SH409): refused, nothing was stored.
      if (definerRefusal(error)?.code === "conflict") return { kind: "refused" };
      throw error;
    }
  }

  // The channel is stored by now, so it is connected whatever the health look comes to: a failed look is logged and the
  // next health check records the health.
  async #recordHealthOnce(
    principal: TenantCtx,
    workspaceId: string,
    channelId: string,
    provider: HealthProvider,
  ): Promise<void> {
    try {
      await this.#recordHealth(principal, workspaceId, channelId, provider);
    } catch (error) {
      const { logger } = this.#deps;
      const errorClass = errorClassOf(error);
      logger.warn(
        { event: "connect_health_unrecorded", workspaceId, channelId, errorClass },
        "the health of a new channel was not recorded",
      );
    }
  }

  // Looks at the channel's health, and again when the first look says failing: a revoked answer right after a connect
  // is confirmed before it is shown. The result is recorded with its check time.
  async #recordHealth(
    principal: TenantCtx,
    workspaceId: string,
    channelId: string,
    provider: HealthProvider,
  ) {
    const { checker, pool } = this.#deps;
    let reading = await checker.observe(workspaceId, channelId, provider);
    if (reading.health === "failing") reading = await checker.observe(workspaceId, channelId, provider);
    const { snapshot } = reading;
    await withTenant(pool, principal, (tx) =>
      tx.query(RECORD_HEALTH, [
        workspaceId,
        channelId,
        reading.health,
        snapshot.manifestDigest,
        snapshot.apiVersion,
        snapshot.sunsetAt,
        JSON.stringify(snapshot.capabilities),
        JSON.stringify(snapshot.limits),
      ]),
    );
  }
}

export const createConnectService = (deps: ConnectDeps): ConnectService => new ConnectService(deps);
