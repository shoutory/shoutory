import type { AdapterContext, CommitInput, ProviderAdapter, RemotePost } from "../adapter.js";
import { type Effect, MAX_RETRY_DELAY_MS, type ProviderErrorClass, type ProviderResult } from "../result.js";
import { PLANTED, problemWith } from "./kit.js";

export type MatrixOperation = "commit" | "readBack" | "delete" | "edit";
export type MatrixCapability = "edit" | "thread" | "first_comment";

export type MatrixFault =
  | {
      readonly kind: "respond";
      readonly status: number;
      readonly providerCode?: string;
      /** Puts this id in the error body, so an adapter that reads an id out of an error is caught. */
      readonly echoId?: string;
      /** The Retry-After header value as the provider sends it: seconds or an HTTP date. */
      readonly retryAfter?: string;
      /** The effect happened at the provider and only the answer differs. */
      readonly afterEffect?: boolean;
    }
  | { readonly kind: "hang"; readonly effectDelayMs?: number }
  // The effect happened and the answer's body ends short of its length.
  | { readonly kind: "truncate" };

export interface StoredPost {
  readonly externalId: string;
  readonly text: string;
  readonly replyToExternalId?: string;
}

export interface MatrixHarness {
  readonly adapter: ProviderAdapter;
  readonly context: AdapterContext;
  arm(operation: MatrixOperation, fault: MatrixFault): void;
  effects(): number;
  settle(): Promise<void>;
  stored(): readonly StoredPost[];
  requestCount(): number;
}

export interface MatrixProfile {
  readonly badRequestCodes: readonly string[];
  readonly absentStatus: number;
  readonly revokedCode: string;
  readonly capabilities: readonly MatrixCapability[];
}

export interface FaultRow {
  readonly id: string;
  readonly title: string;
  run(harness: MatrixHarness): Promise<void>;
}

interface Allowed {
  readonly effect: Effect;
  readonly classes: readonly ProviderErrorClass[];
}

const TIMEOUT_MS = 100;
const LATE_EFFECT_MS = 300;
const NO_EFFECT = (...classes: ProviderErrorClass[]): Allowed => ({ effect: "none", classes });
const MAYBE_EFFECT: Allowed = { effect: "possible", classes: ["unknown", "retryable_after_send"] };

let keyCounter = 0;
const commitInput = (text = "matrix text", replyToExternalId?: string): CommitInput => ({
  idempotencyKey: `matrix-key-${++keyCounter}`,
  text,
  ...(replyToExternalId === undefined ? {} : { replyToExternalId }),
});

const withTimeout = (context: AdapterContext): AdapterContext => ({
  ...context,
  fetch: ((input, init) =>
    context.fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })) as typeof fetch,
});

// What undici throws when the connection cannot be opened: nothing was sent.
const connectFailure = (context: AdapterContext): AdapterContext => ({
  ...context,
  fetch: (() =>
    Promise.reject(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      }),
    )) as typeof fetch,
});

// One adapter call sends at most one request: a resend after an unknown outcome is the ledger's decision, never the
// adapter's.
async function played(
  harness: MatrixHarness,
  operation: MatrixOperation,
  fault: MatrixFault | undefined,
  call: () => Promise<ProviderResult>,
) {
  const before = harness.effects();
  const requestsBefore = harness.requestCount();
  if (fault) harness.arm(operation, fault);
  const result = await call();
  await harness.settle();
  const sent = harness.requestCount() - requestsBefore;
  if (sent > 1) throw new Error(`one adapter call sent ${sent} requests`);
  return { result, delta: harness.effects() - before };
}

function expectError(
  situation: string,
  played_: { result: ProviderResult; delta: number },
  allowed: Allowed[],
) {
  const { result, delta } = played_;
  const problem = problemWith(result);
  if (problem) throw new Error(`${situation}: the result ${problem}`);
  const fits = allowed.some(
    (pair) => pair.effect === result.effect && result.errorClass && pair.classes.includes(result.errorClass),
  );
  if (!fits) throw new Error(`${situation}: ${result.effect} with ${result.errorClass} is not allowed here`);
  if (result.effect === "none" && delta > 0)
    throw new Error(`${situation}: reported no effect after ${delta} effect(s) at the provider`);
}

async function seeded(harness: MatrixHarness): Promise<RemotePost> {
  const result = await harness.adapter.commit(harness.context, commitInput());
  if (!result.ok || !result.externalId)
    throw new Error("a successful commit must be ok and carry an externalId");
  return { externalId: result.externalId };
}

async function chain(harness: MatrixHarness, texts: readonly string[]): Promise<void> {
  const ids: string[] = [];
  for (const text of texts) {
    const result = await harness.adapter.commit(harness.context, commitInput(text, ids.at(-1)));
    if (!result.ok || !result.externalId) throw new Error(`the part "${text}" was not published`);
    ids.push(result.externalId);
  }
  const posts = harness.stored().filter((post) => ids.includes(post.externalId));
  const inOrder = posts.map((post) => post.externalId).join() === ids.join();
  const linked = posts.every((post, index) => post.replyToExternalId === ids[index - 1]);
  if (!inOrder || !linked)
    throw new Error("the parts were not published in order, each a reply to the one before");
}

async function successRow(harness: MatrixHarness): Promise<void> {
  const before = harness.effects();
  const commit = await harness.adapter.commit(harness.context, commitInput());
  if (!commit.ok || commit.effect !== "confirmed" || !commit.externalId)
    throw new Error("a commit that succeeds must be ok, confirmed and carry an externalId");
  if (harness.effects() - before !== 1) throw new Error("one commit must produce one effect");
  const post = { externalId: commit.externalId };
  const found = await harness.adapter.readBack(harness.context, post);
  if (!found.ok || found.externalId !== commit.externalId)
    throw new Error("the read-back must find the post");
  if (!(await harness.adapter.delete(harness.context, post)).ok) throw new Error("the delete must succeed");
}

const respond = (
  status: number,
  rest: { providerCode?: string; retryAfter?: string; afterEffect?: boolean } = {},
): MatrixFault => ({ kind: "respond", status, echoId: PLANTED, ...rest });

const commitRow = (
  id: string,
  title: string,
  fault: MatrixFault | undefined,
  allowed: Allowed[],
  context: (base: AdapterContext) => AdapterContext = (base) => base,
): FaultRow => ({
  id,
  title,
  run: async (harness) => {
    const call = () => harness.adapter.commit(context(harness.context), commitInput());
    expectError(title, await played(harness, "commit", fault, call), allowed);
  },
});

async function expectRetryAfter(
  harness: MatrixHarness,
  retryAfter: string | undefined,
): Promise<ProviderResult> {
  const fault = respond(429, retryAfter === undefined ? {} : { retryAfter });
  const call = () => harness.adapter.commit(harness.context, commitInput());
  const answer = await played(harness, "commit", fault, call);
  expectError("a 429", answer, [NO_EFFECT("rate_limited")]);
  return answer.result;
}

function rateLimitRows(): FaultRow[] {
  return [
    {
      id: "rate-limit-with-retry-after",
      title: "a 429 with Retry-After is rate_limited with no effect and the delay in milliseconds",
      run: async (harness) => {
        const { retryAfterMs } = await expectRetryAfter(harness, "7");
        if (retryAfterMs !== 7000) throw new Error(`Retry-After 7 became ${retryAfterMs} ms`);
      },
    },
    {
      id: "rate-limit-retry-after-http-date",
      title:
        "a 429 with an HTTP-date Retry-After is rate_limited with no effect and the time left in milliseconds",
      run: async (harness) => {
        const date = new Date(harness.context.now().getTime() + 30_000).toUTCString();
        const { retryAfterMs } = await expectRetryAfter(harness, date);
        if (retryAfterMs !== 30_000) throw new Error(`Retry-After ${date} became ${retryAfterMs} ms`);
      },
    },
    {
      id: "rate-limit-without-retry-after",
      title: "a 429 without Retry-After is rate_limited with no effect and no delay",
      run: async (harness) => {
        const { retryAfterMs } = await expectRetryAfter(harness, undefined);
        if (retryAfterMs !== undefined) throw new Error("a delay appeared from nowhere");
      },
    },
    {
      id: "rate-limit-retry-after-above-maximum",
      title: "a 429 with a ten-day Retry-After is rate_limited with no effect and a bounded delay",
      run: async (harness) => {
        const { retryAfterMs } = await expectRetryAfter(harness, "864000");
        if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_DELAY_MS)
          throw new Error(`a ten-day Retry-After reached the result as ${retryAfterMs} ms`);
      },
    },
  ];
}

function afterEffectRow(operation: "edit" | "delete"): FaultRow {
  const title = `a 503 after a ${operation} took effect is unknown or retryable after send, never none`;
  return {
    id: `server-error-after-${operation}`,
    title,
    run: async (harness) => {
      const post = await seeded(harness);
      const { adapter, context } = harness;
      const call = async () => {
        if (operation === "delete") return adapter.delete(context, post);
        if (!adapter.edit) throw new Error("the manifest declares edit but the adapter has none");
        return adapter.edit(context, post, { text: "matrix edited" });
      };
      const fault = respond(503, { afterEffect: true });
      expectError(title, await played(harness, operation, fault, call), [MAYBE_EFFECT]);
    },
  };
}

function targetRows(profile: MatrixProfile): FaultRow[] {
  return [
    {
      id: "read-back-absent",
      title: "an absent answer on read-back is a permanent failure with no effect",
      run: async (harness) => {
        const post = await seeded(harness);
        const call = () => harness.adapter.readBack(harness.context, post);
        const fault = respond(profile.absentStatus);
        expectError("a read-back absent answer", await played(harness, "readBack", fault, call), [
          NO_EFFECT("permanent"),
        ]);
      },
    },
    {
      id: "delete-absent",
      title: "an absent answer on delete means the post is gone: ok with no effect",
      run: async (harness) => {
        const post = await seeded(harness);
        const call = () => harness.adapter.delete(harness.context, post);
        const { result, delta } = await played(harness, "delete", respond(profile.absentStatus), call);
        if (!result.ok || result.effect !== "none" || delta !== 0)
          throw new Error(
            "deleting an absent post must be ok with effect none and no effect at the provider",
          );
      },
    },
    afterEffectRow("delete"),
  ];
}

function capabilityRows(capabilities: readonly MatrixCapability[]): FaultRow[] {
  const rows: [MatrixCapability, FaultRow][] = [
    [
      "edit",
      {
        id: "edit-published-post",
        title: "an edit changes the published post and counts one effect",
        run: async (harness) => {
          const post = await seeded(harness);
          const { adapter, context } = harness;
          const answer = await played(harness, "edit", undefined, async () => {
            if (!adapter.edit) throw new Error("the manifest declares edit but the adapter has none");
            return adapter.edit(context, post, { text: "matrix edited" });
          });
          const stored = harness.stored().find((item) => item.externalId === post.externalId);
          if (!answer.result.ok || answer.delta !== 1 || stored?.text !== "matrix edited")
            throw new Error("the edit must succeed, change the post and count one effect");
        },
      },
    ],
    ["edit", afterEffectRow("edit")],
    [
      "thread",
      {
        id: "thread-parts-in-order",
        title: "thread parts are published as replies in order",
        run: (harness) => chain(harness, ["part 1", "part 2", "part 3"]),
      },
    ],
    [
      "first_comment",
      {
        id: "first-comment",
        title: "a first comment is published as a reply to the post",
        run: (harness) => chain(harness, ["post", "first comment"]),
      },
    ],
  ];
  return rows.filter(([capability]) => capabilities.includes(capability)).map(([, row]) => row);
}

// The 401, 403 and 409 rows name the situation played and accept only the classes that situation allows; no row maps a
// status to a class.
export function faultMatrixRows(profile: MatrixProfile): readonly FaultRow[] {
  return [
    { id: "success", title: "a commit, read-back and delete that succeed", run: successRow },
    ...refusalRows(profile),
    ...targetRows(profile),
    ...rateLimitRows(),
    ...uncertainRows(),
    ...capabilityRows(profile.capabilities),
  ];
}

function refusalRows(profile: MatrixProfile): FaultRow[] {
  return [
    ...profile.badRequestCodes.map((code) =>
      commitRow(
        `bad-request-${code}`,
        `a 400 coded ${code} is permanent with no effect`,
        respond(400, { providerCode: code }),
        [NO_EFFECT("permanent")],
      ),
    ),
    commitRow(
      "revoked-grant",
      "a 401 for a revoked grant is auth_revoked with no effect",
      respond(401, { providerCode: profile.revokedCode }),
      [NO_EFFECT("auth_revoked")],
    ),
    commitRow(
      "per-target-refusal",
      "a 403 refusing this one target is permanent with no effect",
      respond(403),
      [NO_EFFECT("permanent")],
    ),
    commitRow(
      "duplicate-after-send",
      "a 409 duplicate after the post was created is unknown or retryable after send, never none",
      respond(409, { afterEffect: true }),
      [MAYBE_EFFECT],
    ),
    commitRow("payload-too-large", "a 413 is permanent with no effect", respond(413), [
      NO_EFFECT("permanent"),
    ]),
  ];
}

// Outcomes the adapter cannot know: it may only say "none" where nothing was sent or the provider said it did nothing.
function uncertainRows(): FaultRow[] {
  return [
    commitRow(
      "server-error-before-effect",
      "a 503 before any effect is retryable before send or unknown",
      respond(503),
      [NO_EFFECT("retryable_before_send"), MAYBE_EFFECT],
    ),
    commitRow(
      "server-error-after-effect",
      "a 503 after the post was created is never reported as no effect",
      respond(503, { afterEffect: true }),
      [MAYBE_EFFECT],
    ),
    commitRow(
      "connect-timeout",
      "a connect timeout is retryable before send with no effect",
      undefined,
      [NO_EFFECT("retryable_before_send")],
      connectFailure,
    ),
    commitRow(
      "read-timeout-after-send",
      "a read timeout after the body was sent may have had an effect",
      { kind: "hang" },
      [MAYBE_EFFECT],
      withTimeout,
    ),
    commitRow(
      "truncated-body",
      "an answer cut short after the post was created may have had an effect",
      { kind: "truncate" },
      [MAYBE_EFFECT],
    ),
    commitRow(
      "late-success",
      "a post that appears after a timeout is never reported as no effect",
      { kind: "hang", effectDelayMs: LATE_EFFECT_MS },
      [MAYBE_EFFECT],
      withTimeout,
    ),
  ];
}
