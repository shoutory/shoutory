import { createHash, randomInt } from "node:crypto";
import { type Aad, FORMAT_VERSION, open, SealedSecret, seal } from "@shoutory/core/crypto";
import { pepperDigest } from "@shoutory/core/crypto/digest";
import type { KeyProvider } from "@shoutory/core/keys";
import { withTenant } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import type { AdapterContext, SecretKind } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import { z } from "zod";
import { Refusal } from "../errors/refusal.js";
import type { Scoped } from "../routes/define-route.js";
import { definerRefusal } from "../routes/definer-refusal.js";
import type { ConnectService } from "./connect.js";
import { type CredentialService, deadlineFetch, ensureSalt, sealedParams } from "./credentials.js";
import type { HealthProvider } from "./health.js";

export interface SecretConnectDeps {
  readonly pool: AppPool;
  readonly keys: KeyProvider;
  readonly pepper: SealedSecret;
  readonly fetch: typeof fetch;
  readonly fetchFor?: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
  readonly resolveTxt?: AdapterContext["resolveTxt"];
  readonly now: () => Date;
  readonly providers: Readonly<Record<string, HealthProvider>>;
  readonly credentials: CredentialService;
  readonly connect: ConnectService;
}

interface Caller {
  readonly workspaceId: string;
  readonly providerId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly ipHmac: Buffer;
}

export type PasteOutcome =
  | { readonly kind: "connected"; readonly channelId: string }
  | {
      readonly kind: "challenge";
      readonly challengeId: string;
      readonly word: string;
      readonly expiresAt: Date;
    };

const CHALLENGE_MINUTES = 10;
// No letter that reads as a digit or the other way round: the person types this word into a chat.
const WORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const WORD_LENGTH = 10;

const newWord = (): string =>
  Array.from({ length: WORD_LENGTH }, () => WORD_ALPHABET[randomInt(WORD_ALPHABET.length)]).join("");
export const wordDigest = (word: string): Buffer =>
  createHash("sha256").update(word.trim().toLowerCase()).digest();

const challengeAad = (workspaceId: string, challengeId: string): Aad => ({
  formatVersion: FORMAT_VERSION,
  scopeId: workspaceId,
  ownerId: challengeId,
  credentialKind: "bot_token",
  generation: 1,
});

const bytes = z.instanceof(Buffer);
const takenSchema = z.object({
  id: z.string(),
  channel_id: z.string().nullable(),
  matched_chat_id: z.string(),
  matched_title: z.string(),
  format_version: z.number().int(),
  key_id: z.string(),
  iv: bytes,
  ciphertext: bytes,
  auth_tag: bytes,
  wrap_iv: bytes,
  wrap_tag: bytes,
  wrapped_dek: bytes,
});
const statusSchema = z.object({
  state: z.enum(["waiting", "matched", "expired", "done", "ended"]),
  matched_title: z.string().nullable(),
  reason: z.enum(["bot_cannot_post"]).nullable(),
});

const refused = (reason: string) =>
  new Refusal("unprocessable_content", `secret refused: ${reason}`, { details: { reason } });

// The raw text is checked as well as the parsed address: parsing drops a default port, an empty query or user, tabs and
// newlines, and lower-cases the host, so the text before the first slash must be the parsed host exactly.
function hostAllowed(manifest: Manifest, secret: string): boolean {
  if (!URL.canParse(secret) || /[?#]/.test(secret)) return false;
  const authority = /^https:\/\/([^/]*)/.exec(secret)?.[1];
  if (authority === undefined || authority === "") return false;
  const { hostname } = new URL(secret);
  return authority === hostname && (manifest.egressHosts ?? []).includes(hostname);
}

// An answer the provider gave about the secret itself is a refusal of it; any other failure is the provider's.
function failureOf(result: ProviderResult): Refusal {
  if (result.errorClass === "rate_limited") {
    return new Refusal("too_many_requests", "the provider limited the check of the secret", {
      details: { reason: "provider_rate_limited" },
    });
  }
  if (result.errorClass === "permanent" || result.errorClass === "auth_revoked")
    return refused("secret_refused");
  return new Refusal("service_unavailable", "the provider did not answer the check of the secret", {
    details: { reason: "provider_unreachable" },
  });
}

export class SecretConnect {
  readonly #deps: SecretConnectDeps;

  constructor(deps: SecretConnectDeps) {
    this.#deps = deps;
  }

  #providerOf(providerId: string): { provider: HealthProvider; kind: SecretKind } {
    const provider = Object.hasOwn(this.#deps.providers, providerId)
      ? this.#deps.providers[providerId]
      : undefined;
    const method = provider?.manifest.auth.method;
    if (!provider?.adapter.connect?.verifySecret || (method !== "bot_token" && method !== "webhook_url")) {
      throw new Refusal("not_found", "no secret connect for the provider");
    }
    return { provider, kind: method };
  }

  #context(manifest: Manifest): AdapterContext {
    const egress = this.#deps.fetchFor?.(manifest, undefined) ?? this.#deps.fetch;
    return { fetch: deadlineFetch(egress), now: this.#deps.now, resolveTxt: this.#deps.resolveTxt };
  }

  async paste(
    scoped: Scoped,
    caller: Caller,
    input: { secret: string; channelId?: string | undefined },
  ): Promise<PasteOutcome> {
    const { provider, kind } = this.#providerOf(caller.providerId);
    // An archived workspace refuses here, before any call to the provider.
    await scoped(true, async () => undefined);
    // The host is checked against the manifest before any request leaves.
    if (kind === "webhook_url" && !hostAllowed(provider.manifest, input.secret))
      throw refused("host_not_allowed");
    const checked = await provider.adapter.connect?.verifySecret?.(this.#context(provider.manifest), {
      kind,
      secret: new SealedSecret(input.secret),
    });
    if (!checked?.ok || !checked.identity) throw failureOf(checked ?? { ok: false, effect: "none" });
    if (kind === "webhook_url") {
      const { identity } = checked;
      const channelId = await this.#store(caller, provider, {
        identity,
        secret: input.secret,
        kind,
        reconnectChannelId: input.channelId,
      });
      return { kind: "connected", channelId };
    }
    const botDigest = Buffer.from(
      pepperDigest(this.#deps.pepper, "bot", `${caller.providerId}:${checked.identity.providerAccountId}`),
      "hex",
    );
    return this.#hold(scoped, caller, { secret: input.secret, botDigest, channelId: input.channelId });
  }

  async #hold(
    scoped: Scoped,
    caller: Caller,
    input: { secret: string; botDigest: Buffer; channelId: string | undefined },
  ): Promise<PasteOutcome> {
    const word = newWord();
    const challengeId = await scoped(true, async (tx) => {
      const salt = await ensureSalt(tx, caller.workspaceId);
      const id = String((await tx.query("SELECT uuidv7() AS id")).rows[0]?.id);
      const stored = seal(input.secret, challengeAad(caller.workspaceId, id), this.#deps.keys, salt);
      try {
        await tx.query(
          "SELECT app.connect_challenge_put($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
          [
            id,
            caller.workspaceId,
            caller.providerId,
            wordDigest(word),
            input.botDigest,
            input.channelId ?? null,
            ...sealedParams(stored),
          ],
        );
      } catch (error) {
        throw definerRefusal(error) ?? error;
      }
      return id;
    });
    return { kind: "challenge", challengeId, word, expiresAt: this.#expiry() };
  }

  #expiry(): Date {
    return new Date(this.#deps.now().getTime() + CHALLENGE_MINUTES * 60_000);
  }

  async status(scoped: Scoped, caller: Pick<Caller, "workspaceId" | "providerId">, challengeId: string) {
    const found = await scoped(false, (tx) =>
      tx.query("SELECT * FROM app.connect_challenge_status($1, $2, $3)", [
        caller.workspaceId,
        caller.providerId,
        challengeId,
      ]),
    );
    if (!found.rows[0]) throw new Refusal("not_found", "no such challenge");
    const row = statusSchema.parse(found.rows[0]);
    return { state: row.state, chatTitle: row.matched_title, reason: row.reason };
  }

  async renew(scoped: Scoped, caller: Pick<Caller, "workspaceId" | "providerId">, challengeId: string) {
    const word = newWord();
    const renewed = await scoped(true, async (tx) => {
      try {
        return await tx.query("SELECT app.connect_challenge_renew($1, $2, $3, $4) AS expires", [
          caller.workspaceId,
          caller.providerId,
          challengeId,
          wordDigest(word),
        ]);
      } catch (error) {
        throw definerRefusal(error) ?? error;
      }
    });
    if (renewed.rows[0]?.expires == null) throw new Refusal("not_found", "no such challenge");
    return { word, expiresAt: this.#expiry() };
  }

  async complete(caller: Caller, challengeId: string, word: string): Promise<string> {
    const { provider } = this.#providerOf(caller.providerId);
    const principal = { principalKind: "user", principalId: caller.userId } as const;
    const taken = await withTenant(this.#deps.pool, principal, (tx) =>
      tx.query("SELECT * FROM app.connect_challenge_take($1, $2, $3, $4)", [
        caller.workspaceId,
        caller.providerId,
        challengeId,
        wordDigest(word),
      ]),
    );
    // Every miss alike: another workspace's challenge, a wrong word, none answered yet, one already taken or ended.
    if (!taken.rows[0]) throw new Refusal("not_found", "no such challenge");
    const row = takenSchema.parse(taken.rows[0]);
    const salt = await withTenant(this.#deps.pool, principal, (tx) => ensureSalt(tx, caller.workspaceId));
    const secret = open(
      {
        formatVersion: row.format_version,
        keyId: row.key_id,
        iv: row.iv,
        ciphertext: row.ciphertext,
        tag: row.auth_tag,
        wrapIv: row.wrap_iv,
        wrapTag: row.wrap_tag,
        wrappedDek: row.wrapped_dek,
      },
      challengeAad(caller.workspaceId, row.id),
      this.#deps.keys,
      salt,
    ).expose();
    const identity = {
      providerId: caller.providerId,
      accountKind: "chat",
      providerAccountId: row.matched_chat_id,
      displayName: row.matched_title,
    };
    return this.#store(caller, provider, {
      identity,
      secret,
      kind: "bot_token",
      reconnectChannelId: row.channel_id ?? undefined,
      takenChallengeId: row.id,
    });
  }

  async #store(
    caller: Caller,
    provider: HealthProvider,
    input: {
      identity: Omit<Parameters<CredentialService["connect"]>[0]["identity"], "providerId"> & {
        providerId?: string;
      };
      secret: string;
      kind: SecretKind;
      reconnectChannelId: string | undefined;
      takenChallengeId?: string;
    },
  ): Promise<string> {
    const principal = { principalKind: "user", principalId: caller.userId } as const;
    try {
      const { channelId } = await this.#deps.credentials.connect({
        principal,
        workspaceId: caller.workspaceId,
        identity: { ...input.identity, providerId: caller.providerId },
        reconnectChannelId: input.reconnectChannelId,
        tokens: { access_token: input.secret },
        credential: { kind: input.kind, takenChallengeId: input.takenChallengeId },
        accessExpiresAt: null,
        snapshot: snapshotOf(provider.manifest, this.#deps.now()),
        audit: { requestId: caller.requestId, ipHmac: caller.ipHmac },
      });
      await this.#deps.connect.recordHealthOnce(principal, caller.workspaceId, channelId, provider);
      return channelId;
    } catch (error) {
      throw definerRefusal(error) ?? error;
    }
  }
}
