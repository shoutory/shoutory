import {
  digestOfState,
  type FlowObject,
  flowObjectSchema,
  issuerAccepted,
  newState,
  pkcePair,
  providerErrorText,
} from "@shoutory/core/connect/flow";
import { normalizeInstanceHost } from "@shoutory/core/connect/host";
import { type Aad, FORMAT_VERSION, open, SealedSecret, seal } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import { type TenantCtx, type TenantTx, withTenant } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import type { AppCredentials, ConnectAdapter } from "@shoutory/provider-sdk/adapter";
import { type Manifest, scopeSetOf } from "@shoutory/provider-sdk/manifest";
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
import { ensureProviderApp, readProviderApp } from "./provider-app.js";

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

export function redirectUriOf(publicOrigin: string, providerId: string, instanceHost?: string): string {
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
  readonly loginHint?: string | undefined;
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
  request_uri: z.string().nullable(),
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
  readonly object: FlowObject;
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

const instanceRefused = (reason: string) =>
  new Refusal("unprocessable_content", `instance refused: ${reason}`, { details: { reason } });

// Each failure keeps its class, so the person is told whether to fix the host, wait, or try again later.
function refusalOf(result: ProviderResult | undefined): Refusal {
  const reason = result?.providerCode;
  if (reason !== undefined && INSTANCE_REASONS.has(reason)) return instanceRefused(reason);
  if (result?.errorClass === "rate_limited") {
    const wait = result.retryAfterMs;
    return new Refusal("too_many_requests", "the instance limited the registration of the app", {
      details: { reason: "instance_rate_limited" },
      ...(wait === undefined ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) }),
    });
  }
  if (result?.errorClass === "permanent" || result?.errorClass === "auth_revoked") {
    return instanceRefused("instance_refused");
  }
  return new Refusal("service_unavailable", "the instance did not answer the registration of the app", {
    details: { reason: "instance_unreachable" },
  });
}

const appKeyOf = (at: Omit<AppKey, "scopes">, manifest: Manifest): AppKey => ({
  ...at,
  scopes: scopeSetOf(manifest),
});

const hostRefusal = (reason: "host_invalid" | "host_mismatch") =>
  new Refusal("unprocessable_content", `instance host refused: ${reason}`, { details: { reason } });

function hostOf(typed: string | undefined): string | undefined {
  if (typed === undefined) return undefined;
  const host = normalizeInstanceHost(typed);
  if (host === undefined) throw hostRefusal("host_invalid");
  return host;
}

const CHANNEL_HOST =
  "SELECT instance_host FROM app.channels WHERE id = $1 AND workspace_id = $2 AND provider_id = $3";

// A reconnect of an instance channel runs on the host the channel was connected on: the person need not type it again,
// and a different typed host would rebind the channel to another instance's account.
async function reconnectHostOf(scoped: Scoped, input: StartInput, connect: ConnectAdapter) {
  const typed = hostOf(input.instanceHost);
  const { channelId } = input;
  if (!connect.registerApp || channelId === undefined) return typed;
  const found = await scoped(false, (tx) =>
    tx.query(CHANNEL_HOST, [channelId, input.workspaceId, input.providerId]),
  );
  const stored = found.rows[0]?.instance_host;
  if (typeof stored !== "string") throw new Refusal("not_found", "no such channel");
  if (typed !== undefined && typed !== stored) throw hostRefusal("host_mismatch");
  return stored;
}

// What the flow kept for the exchange: the key the token is bound to, the issuer, the pushed request and the hint.
function boundTo(object: FlowObject, requestUri: string | null) {
  return {
    ...(object.dpop_private_jwk === undefined
      ? {}
      : { dpopKey: new SealedSecret(JSON.stringify(object.dpop_private_jwk)) }),
    ...(object.issuer === undefined ? {} : { issuer: object.issuer }),
    ...(requestUri === null ? {} : { requestUri }),
    ...(object.login_hint === undefined ? {} : { loginHint: object.login_hint }),
  };
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

  // The app of the whole instance is made on first use, by whichever connect comes first.
  async #providerApp(scoped: Scoped, input: StartInput, provider: HealthProvider, connect: ConnectAdapter) {
    const { keys } = this.#deps;
    const stored = await scoped(false, (tx) =>
      readProviderApp(tx, keys, input.providerId, input.workspaceId),
    );
    if (stored) return stored;
    const redirectUri = redirectUriOf(this.#deps.publicOrigin, input.providerId);
    const context = { fetch: this.#fetchOf(provider.manifest, undefined), now: this.#deps.now };
    const registered = await connect.registerApp?.(context, { redirectUri });
    if (!registered?.ok || !registered.app) throw refusalOf(registered);
    const made = { ...registered.app, redirectUri };
    return scoped(true, (tx) => ensureProviderApp(tx, keys, input.providerId, input.workspaceId, made));
  }

  async #startApp(scoped: Scoped, input: StartInput, provider: HealthProvider, connect: ConnectAdapter) {
    if (!connect.registerApp) return undefined;
    if (connect.appKind === "provider") return this.#providerApp(scoped, input, provider, connect);
    if (input.instanceHost === undefined)
      throw new Refusal("validation_failed", "the provider needs an instance host");
    const { workspaceId, providerId, instanceHost } = input;
    const key = appKeyOf({ workspaceId, providerId, instanceHost }, provider.manifest);
    return this.#appOf((write, run) => scoped(write, (tx) => run(tx)), { key, provider, connect });
  }

  async start(scoped: Scoped, typed: StartInput): Promise<string> {
    const provider = this.#providerOf(typed.providerId);
    const connect = provider?.adapter.connect;
    if (!provider || !connect) throw new Refusal("not_found", "no connect for the provider");
    // An archived workspace refuses here, before any call to the provider.
    await scoped(true, async () => undefined);
    const input = { ...typed, instanceHost: await reconnectHostOf(scoped, typed, connect) };
    const app = await this.#startApp(scoped, input, provider, connect);
    const { state, digest } = newState();
    const { verifier, challenge } = pkcePair();
    // The provider may push the request, an outbound call, so it runs before the flow is stored and no transaction is open.
    const context = { fetch: this.#fetchOf(provider.manifest, input.instanceHost), now: this.#deps.now };
    const authorized = await connect.authorize(context, {
      state,
      codeChallenge: challenge,
      redirectUri: redirectUriOf(this.#deps.publicOrigin, input.providerId, input.instanceHost),
      ...(input.instanceHost === undefined ? {} : { instanceHost: input.instanceHost }),
      ...(input.loginHint === undefined ? {} : { loginHint: input.loginHint }),
      ...(app === undefined ? {} : { app }),
    });
    const object: FlowObject = {
      code_verifier: verifier,
      ...(authorized.dpopKey === undefined
        ? {}
        : { dpop_private_jwk: JSON.parse(authorized.dpopKey.expose()) }),
      ...(authorized.issuer === undefined ? {} : { issuer: authorized.issuer }),
      ...(input.loginHint === undefined ? {} : { login_hint: input.loginHint }),
    };
    await this.#putFlow(scoped, input, { digest, object, requestUri: authorized.requestUri });
    return authorized.url;
  }

  async #putFlow(
    scoped: Scoped,
    input: StartInput,
    flow: { digest: Buffer; object: FlowObject; requestUri: string | undefined },
  ): Promise<void> {
    await scoped(true, async (tx) => {
      const salt = await ensureSalt(tx, input.workspaceId);
      // The flow id is read first: the owner the sealed object is bound to is the id the row will carry.
      const flowId = String((await tx.query("SELECT uuidv7() AS id")).rows[0]?.id);
      const aad = flowAadOf(input.workspaceId, flowId);
      const stored = seal(JSON.stringify(flowObjectSchema.parse(flow.object)), aad, this.#deps.keys, salt);
      try {
        await tx.query(PUT_FLOW, [
          flowId,
          input.workspaceId,
          input.providerId,
          flow.digest,
          input.channelId ?? null,
          input.instanceHost ?? null,
          ...sealedParams(stored),
          flow.requestUri ?? null,
        ]);
      } catch (error) {
        throw definerRefusal(error) ?? error;
      }
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
    const progress = { step: "unseal" };
    let object: FlowObject;
    try {
      object = await this.#flowObjectOf(principal, taken);
    } catch (error) {
      return this.#failed(input.providerId, progress.step, errorClassOf(error));
    }
    // An error answer carries the issuer too (RFC 9207 section 2, https://www.rfc-editor.org/rfc/rfc9207#section-2,
    // read 2026-11-24), so a forged error from another server is refused before its text is shown. A provider that finds
    // its server at the start has no fixed issuer: the one its flow kept is the one the callback must carry.
    if (!issuerAccepted(connect.issuer ?? object.issuer, query.iss)) return { kind: "refused" };
    if (query.error !== undefined) {
      return { kind: "provider_error", message: providerErrorText(query.error_description ?? query.error) };
    }
    if (query.code === undefined) return this.#failed(input.providerId, "callback", "none");
    try {
      const granted = await this.#grant(principal, taken, {
        provider,
        connect,
        code: query.code,
        input,
        progress,
        object,
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

  async #flowObjectOf(principal: TenantCtx, flow: FlowRow): Promise<FlowObject> {
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
    return flowObjectSchema.parse(JSON.parse(plain));
  }

  async #storedApp(
    principal: TenantCtx,
    flow: FlowRow,
    step: { connect: ConnectAdapter; providerId: string },
  ) {
    if (!step.connect.registerApp) return undefined;
    if (step.connect.appKind === "provider") {
      const app = await withTenant(this.#deps.pool, principal, (tx) =>
        readProviderApp(tx, this.#deps.keys, step.providerId, flow.workspace_id),
      );
      if (!app) throw new Error("the provider has no stored app");
      return app;
    }
    if (flow.instance_host === null) throw new Error("the flow of an instance provider has no instance host");
    const provider = this.#providerOf(step.providerId);
    if (!provider) throw new Error("the flow names a provider that is not registered");
    const at = {
      workspaceId: flow.workspace_id,
      providerId: step.providerId,
      instanceHost: flow.instance_host,
    };
    const key = appKeyOf(at, provider.manifest);
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
      object: FlowObject;
    },
  ): Promise<Granted | GrantFailure> {
    const { progress, connect, input, object } = step;
    const host = flow.instance_host ?? undefined;
    const context = { fetch: this.#fetchOf(step.provider.manifest, host), now: this.#deps.now };
    const hostPart = host === undefined ? {} : { instanceHost: host };
    const app = await this.#storedApp(principal, flow, { connect, providerId: input.providerId });
    const bound = boundTo(object, flow.request_uri);
    progress.step = "exchange";
    const exchanged = await connect.exchangeCode(context, {
      code: step.code,
      codeVerifier: new SealedSecret(object.code_verifier),
      redirectUri: redirectUriOf(this.#deps.publicOrigin, input.providerId, host),
      ...hostPart,
      ...(app === undefined ? {} : { app }),
      ...bound,
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
    const who = await connect.identity(context, {
      accessToken,
      ...hostPart,
      ...(bound.dpopKey === undefined ? {} : { dpopKey: bound.dpopKey }),
    });
    if (!who.ok || !who.identity) return { step: "identity", errorClass: who.errorClass ?? "none" };
    if (who.limitsFromManifest?.length) {
      const fields = who.limitsFromManifest;
      this.#deps.logger.info(
        { event: "instance_limits_from_manifest", providerId: input.providerId, fields },
        "the instance left limits to the manifest",
      );
    }
    return { credential: exchanged.credential, identity: who.identity, limits: who.limits, object };
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
    const at = {
      workspaceId: flow.workspace_id,
      providerId: input.providerId,
      instanceHost: flow.instance_host,
    };
    const key = appKeyOf(at, step.provider.manifest);
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
    const { credential, identity, object } = step.granted;
    const { accessToken, refreshToken, expiresInSeconds } = credential;
    const dpopKey = credential.dpopPrivateJwk ?? object.dpop_private_jwk;
    const issuer = credential.issuer ?? object.issuer;
    const now = this.#deps.now();
    try {
      const { channelId } = await this.#deps.credentials.connect({
        principal,
        workspaceId: flow.workspace_id,
        identity: {
          providerId: step.input.providerId,
          ...identity,
          instanceHost: flow.instance_host ?? identity.instanceHost,
        },
        reconnectChannelId: flow.channel_id ?? undefined,
        tokens: {
          access_token: accessToken.expose(),
          ...(refreshToken === undefined ? {} : { refresh_token: refreshToken.expose() }),
          ...(dpopKey === undefined ? {} : { dpop_private_jwk: dpopKey }),
          ...(issuer === undefined ? {} : { issuer }),
        },
        accessExpiresAt: expiryOf(now, expiresInSeconds),
        snapshot: snapshotWithLimits(snapshotOf(step.provider.manifest, now), step.granted.limits),
        audit: { requestId: step.input.requestId, ipHmac: step.input.ipHmac },
      });
      await this.recordHealthOnce(principal, flow.workspace_id, channelId, step.provider);
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
  async recordHealthOnce(
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
