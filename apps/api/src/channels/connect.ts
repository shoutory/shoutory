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
import type { AppCredentials, ConnectAdapter } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type {
  AccountIdentity,
  ProviderResult,
  ReadLimit,
  RefreshedCredential,
} from "@shoutory/provider-sdk/result";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import { z } from "zod";
import { Refusal } from "../errors/refusal.js";
import type { Logger } from "../logging/logger.js";
import type { Scoped } from "../routes/define-route.js";
import { definerRefusal } from "../routes/definer-refusal.js";
import { type CredentialService, deadlineFetch, ensureSalt, expiryOf, sealedParams } from "./credentials.js";
import type { HealthChecker, HealthProvider } from "./health.js";
import { type AppKey, readApp, writeApp } from "./instance-app.js";

export interface ConnectDeps {
  readonly pool: AppPool;
  readonly keys: KeyProvider;
  readonly fetch: typeof fetch;
  readonly fetchFor?: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
  readonly now: () => Date;
  readonly publicOrigin: string;
  readonly providers: Readonly<Record<string, HealthProvider>>;
  readonly credentials: CredentialService;
  readonly checker: HealthChecker;
  readonly logger: Logger;
}

function redirectUriOf(publicOrigin: string, providerId: string, instanceHost?: string): string {
  const base = `${publicOrigin}/api/v1/connect/${providerId}/callback`;
  if (instanceHost === undefined) return base;
  return `${base}?${new URLSearchParams({ instance_host: instanceHost })}`;
}

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
  readonly channelId?: string | undefined;
}

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

type Outcome =
  | { readonly kind: "connected"; readonly channelId: string }
  | { readonly kind: "start_again" | "refused" | "failed" }
  | { readonly kind: "provider_error"; readonly message: string }
  | { readonly kind: "wrong_account"; readonly channelId: string };

export type ConnectOutcome = Outcome & { readonly workspaceId?: string };

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

interface Granted {
  readonly credential: RefreshedCredential;
  readonly identity: AccountIdentity;
  readonly limits?: Readonly<Record<string, ReadLimit>> | undefined;
}

interface GrantFailure {
  readonly step: string;
  readonly errorClass: string;
  readonly providerCode?: string | undefined;
  readonly refusedApp?: string | undefined;
}

// The limits an instance states replace the manifest's documented ones of the same name.
const snapshotWithLimits = <S extends { readonly limits: Readonly<Record<string, ReadLimit>> }>(
  snapshot: S,
  limits: Readonly<Record<string, ReadLimit>> | undefined,
): S => (limits === undefined ? snapshot : { ...snapshot, limits: { ...snapshot.limits, ...limits } });

type InTx = <T>(write: boolean, run: (tx: TenantTx) => Promise<T>) => Promise<T>;
interface AppStep {
  readonly key: AppKey;
  readonly provider: HealthProvider;
  readonly connect: ConnectAdapter;
}

// The reasons an instance can be refused with, each fixed: an answer names no host, address or class (no port scanner).
const INSTANCE_REASONS: ReadonlySet<string> = new Set(["instance_unsupported", "address_not_allowed"]);

function refusalOf(result: ProviderResult | undefined): Refusal {
  const reason = result?.providerCode;
  if (reason !== undefined && INSTANCE_REASONS.has(reason)) {
    return new Refusal("unprocessable_content", `instance refused: ${reason}`, { details: { reason } });
  }
  return new Refusal("service_unavailable", "the instance did not answer the registration of the app");
}

const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const PUT_FLOW =
  "SELECT app.oauth_flow_put($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)";
const TAKE_FLOW = "SELECT * FROM app.oauth_flow_take($1, $2, $3, $4, $5)";
const RECORD_HEALTH = "SELECT app.channel_health_record($1, $2, $3, $4, $5, $6, $7, $8)";
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

  #fetchOf(manifest: Manifest, host: string | undefined): typeof fetch {
    return deadlineFetch(this.#deps.fetchFor?.(manifest, host) ?? this.#deps.fetch);
  }

  // Registering is an outbound call, so no transaction is open. When another connect stored an app first, this one's
  // is dropped and the winner's read; `replaces` names the client id an instance no longer knows.
  async #appOf(inTx: InTx, step: AppStep, replaces?: string): Promise<AppCredentials> {
    const { key, provider, connect } = step;
    const { keys } = this.#deps;
    if (replaces === undefined) {
      const stored = await inTx(false, (tx) => readApp(tx, keys, key));
      if (stored) return stored;
    }
    const redirectUri = redirectUriOf(this.#deps.publicOrigin, key.providerId, key.instanceHost);
    const context = { fetch: this.#fetchOf(provider.manifest, key.instanceHost), now: this.#deps.now };
    const registered = await connect.registerApp?.(context, { instanceHost: key.instanceHost, redirectUri });
    if (!registered?.ok || !registered.app) throw refusalOf(registered);
    const mine = registered.app;
    if (await inTx(true, (tx) => writeApp(tx, keys, key, mine, replaces ?? null))) return mine;
    const winner = await inTx(false, (tx) => readApp(tx, keys, key));
    if (!winner)
      throw new Refusal("conflict", "the stored app of the instance changed while it was registered");
    return winner;
  }

  async #startApp(scoped: Scoped, input: StartInput, provider: HealthProvider, connect: ConnectAdapter) {
    if (!connect.registerApp) return undefined;
    if (input.instanceHost === undefined)
      throw new Refusal("validation_failed", "the provider needs an instance host");
    const key = {
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      instanceHost: input.instanceHost,
    };
    return this.#appOf((write, run) => scoped(write, (tx) => run(tx)), { key, provider, connect });
  }

  async start(scoped: Scoped, input: StartInput): Promise<string> {
    const provider = this.#providerOf(input.providerId);
    const connect = provider?.adapter.connect;
    if (!provider || !connect) throw new Refusal("not_found", "no connect for the provider");
    const app = await this.#startApp(scoped, input, provider, connect);
    const { state, digest } = newState();
    const { verifier, challenge } = pkcePair();
    await scoped(true, async (tx) => {
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
    });
    return connect.authorize({
      state,
      codeChallenge: challenge,
      redirectUri: redirectUriOf(this.#deps.publicOrigin, input.providerId, input.instanceHost),
      ...(input.instanceHost === undefined ? {} : { instanceHost: input.instanceHost }),
      ...(app === undefined ? {} : { app }),
    });
  }

  async finish(input: FinishInput): Promise<ConnectOutcome> {
    const provider = this.#providerOf(input.providerId);
    const connect = provider?.adapter.connect;
    if (!provider || !connect) return { kind: "refused" };
    const principal = { principalKind: "user", principalId: input.userId } as const;
    const taken = await this.#take(principal, input);
    if ("kind" in taken) return taken;
    const outcome = await this.#complete(principal, taken, { provider, connect, input });
    return { ...outcome, workspaceId: taken.workspace_id };
  }

  async #complete(
    principal: TenantCtx,
    taken: FlowRow,
    step: { provider: HealthProvider; connect: ConnectAdapter; input: FinishInput },
  ): Promise<Outcome> {
    const { provider, connect, input } = step;
    const { query } = input;
    // An error answer carries the issuer too (RFC 9207 section 2, https://www.rfc-editor.org/rfc/rfc9207#section-2,
    // read 2026-11-24), so a forged error from another server is refused before its text is shown.
    if (!issuerAccepted(connect.issuer, query.iss)) return { kind: "refused" };
    if (query.error !== undefined) {
      return { kind: "provider_error", message: providerErrorText(query.error_description ?? query.error) };
    }
    if (query.code === undefined) return this.#failed(input.providerId, "callback", "none");
    const progress = { step: "unseal" };
    try {
      const granted = await this.#grant(principal, taken, {
        provider,
        connect,
        code: query.code,
        input,
        progress,
      });
      if (!("credential" in granted))
        return this.#grantFailed(principal, taken, { provider, connect, input }, granted);
      progress.step = "store";
      return await this.#store(principal, taken, { provider, input, granted });
    } catch (error) {
      // After the take the flow is spent, so nothing thrown from here is a fault of the request: a flow object that cannot
      // be opened (a rotated key, a damaged row) and any other failure alike end as a failed connect.
      return this.#failed(input.providerId, progress.step, errorClassOf(error));
    }
  }

  #failed(providerId: string, step: string, errorClass: string): Outcome {
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

  async #storedApp(
    principal: TenantCtx,
    flow: FlowRow,
    step: { connect: ConnectAdapter; providerId: string },
  ) {
    if (!step.connect.registerApp) return undefined;
    if (flow.instance_host === null) throw new Error("the flow of an instance provider has no instance host");
    const key = {
      workspaceId: flow.workspace_id,
      providerId: step.providerId,
      instanceHost: flow.instance_host,
    };
    const app = await withTenant(this.#deps.pool, principal, (tx) => readApp(tx, this.#deps.keys, key));
    if (!app) throw new Error("the instance has no stored app");
    return app;
  }

  // The code exchange and the account read, outside any transaction: nothing here holds a database connection.
  async #grant(
    principal: TenantCtx,
    flow: FlowRow,
    step: {
      provider: HealthProvider;
      connect: ConnectAdapter;
      code: string;
      input: FinishInput;
      progress: { step: string };
    },
  ): Promise<Granted | GrantFailure> {
    const { progress, connect, input } = step;
    const host = flow.instance_host ?? undefined;
    const context = { fetch: this.#fetchOf(step.provider.manifest, host), now: this.#deps.now };
    const hostPart = host === undefined ? {} : { instanceHost: host };
    const app = await this.#storedApp(principal, flow, { connect, providerId: input.providerId });
    const codeVerifier = new SealedSecret(await this.#verifierOf(principal, flow));
    progress.step = "exchange";
    const exchanged = await connect.exchangeCode(context, {
      code: step.code,
      codeVerifier,
      redirectUri: redirectUriOf(this.#deps.publicOrigin, input.providerId, host),
      ...hostPart,
      ...(app === undefined ? {} : { app }),
    });
    if (!exchanged.ok || !exchanged.credential) {
      return {
        step: "exchange",
        errorClass: exchanged.errorClass ?? "none",
        providerCode: exchanged.providerCode,
        refusedApp: app?.clientId,
      };
    }
    progress.step = "identity";
    const accessToken = exchanged.credential.accessToken;
    const who = await connect.identity(context, { accessToken, ...hostPart });
    if (!who.ok || !who.identity) return { step: "identity", errorClass: who.errorClass ?? "none" };
    return { credential: exchanged.credential, identity: who.identity, limits: who.limits };
  }

  // A grant a provider refused: an instance that no longer knows the app gets a new one in its place (compare-and-set on
  // the client id it refused) and the person connects again; every other refusal is a failed connect.
  async #grantFailed(
    principal: TenantCtx,
    flow: FlowRow,
    step: { provider: HealthProvider; connect: ConnectAdapter; input: FinishInput },
    failure: GrantFailure,
  ): Promise<Outcome> {
    const { input } = step;
    if (
      failure.providerCode !== "invalid_client" ||
      failure.refusedApp === undefined ||
      flow.instance_host === null
    ) {
      return this.#failed(input.providerId, failure.step, failure.errorClass);
    }
    const key = {
      workspaceId: flow.workspace_id,
      providerId: input.providerId,
      instanceHost: flow.instance_host,
    };
    try {
      await this.#appOf(
        (_write, run) => withTenant(this.#deps.pool, principal, run),
        { key, ...step },
        failure.refusedApp,
      );
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return this.#failed(input.providerId, "renew_app", error.code);
    }
    return { kind: "start_again" };
  }

  async #store(
    principal: TenantCtx,
    flow: FlowRow,
    step: { provider: HealthProvider; input: FinishInput; granted: Granted },
  ): Promise<Outcome> {
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
        accessExpiresAt: expiryOf(now, expiresInSeconds),
        snapshot: snapshotWithLimits(snapshotOf(step.provider.manifest, now), step.granted.limits),
        audit: { requestId: step.input.requestId, ipHmac: step.input.ipHmac },
      });
      await this.#recordHealthOnce(principal, flow.workspace_id, channelId, step.provider);
      return { kind: "connected", channelId };
    } catch (error) {
      // The account is not the channel's and nothing was stored: a reconnect names the channel; a first connect has none.
      if (definerRefusal(error)?.code === "conflict") {
        return flow.channel_id === null
          ? { kind: "refused" }
          : { kind: "wrong_account", channelId: flow.channel_id };
      }
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
