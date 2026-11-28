import { z } from "zod";

export const listTargetSchema = z.object({
  variant_id: z.string(),
  channel_id: z.string(),
  schedule_state: z.string(),
  due_at: z.string().nullable(),
  due_tz: z.string().nullable(),
  published_at: z.string().nullable(),
  presence: z.string(),
  hold_reason: z.string().nullable(),
  operation_state: z.string().nullable(),
});
export type ListTarget = z.infer<typeof listTargetSchema>;

export const listRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  author_kind: z.string(),
  updated_at: z.string(),
  excerpt: z.string().nullable(),
  targets: z.array(listTargetSchema),
});
export type ListRow = z.infer<typeof listRowSchema>;

export const operationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.string(),
  effect: z.string(),
  reason_code: z.string().nullable(),
  part_index: z.number().int(),
});

export const evidenceSchema = z.object({
  kind: z.string(),
  level: z.string(),
  outcome_kind: z.string().nullable(),
  permalink: z.string().nullable(),
  observed_at: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const attemptSchema = z.object({
  attempt_no: z.number().int(),
  step: z.string(),
  effect: z.string(),
  http_status: z.number().int().nullable(),
  error_class: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

// `evidence` and `attempts` are absent, not empty, for a person who may not see them.
export const targetSchema = z.object({
  variant_id: z.string(),
  channel_id: z.string(),
  schedule_state: z.string(),
  presence: z.string(),
  published_at: z.string().nullable(),
  due_at: z.string().nullable(),
  due_tz: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()),
  hold_reason: z.string().nullable(),
  operation: operationSchema.nullable(),
  evidence: z.array(evidenceSchema).optional(),
  attempts: z.array(attemptSchema).optional(),
  actions: z.array(z.string()),
});
export type Target = z.infer<typeof targetSchema>;

export const detailSchema = z.object({
  id: z.string(),
  status: z.string(),
  current_version_id: z.string(),
  variants: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      parts: z.array(z.looseObject({ kind: z.string() })),
      settings: z.record(z.string(), z.unknown()),
    }),
  ),
  targets: z.array(targetSchema),
});
export type Detail = z.infer<typeof detailSchema>;

// The OL evidence levels, weakest first: a stronger one is the one shown, whatever is newer.
const LEVEL_RANK: Readonly<Record<string, number>> = {
  human: 1,
  receipt: 2,
  poll_status: 3,
  webhook: 4,
  read_back: 5,
};
const CONFIRMING: ReadonlySet<string> = new Set(["accepted", "verified", "observed", "human_confirmed"]);

const strongest = (list: readonly Evidence[]): Evidence | undefined =>
  list.reduce<Evidence | undefined>(
    (best, one) => ((LEVEL_RANK[one.level] ?? 0) > (LEVEL_RANK[best?.level ?? ""] ?? 0) ? one : best),
    undefined,
  );

export type EvidenceLine = "answer" | "read_back" | "you";

/** How we know a post is live: the strongest confirming evidence, never a weaker one that is newer. */
export function evidenceLine(list: readonly Evidence[] | undefined): EvidenceLine | null {
  const top = strongest((list ?? []).filter((one) => CONFIRMING.has(one.kind)));
  if (!top) return null;
  if (top.level === "human") return "you";
  return top.level === "read_back" ? "read_back" : "answer";
}

const shownOutcome = (list: readonly Evidence[] | undefined): string | null =>
  strongest((list ?? []).filter((one) => one.outcome_kind !== null))?.outcome_kind ?? null;

export const permalinkOf = (list: readonly Evidence[] | undefined): string | null =>
  strongest((list ?? []).filter((one) => one.permalink !== null))?.permalink ?? null;

/** Only an http or https address is a link; anything else is shown as text. */
export function safeLink(address: string): string | null {
  if (!URL.canParse(address)) return null;
  const url = new URL(address);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}

export const factsOfDetail = (target: Target): Facts => ({
  scheduleState: target.schedule_state,
  presence: target.presence,
  publishedAt: target.published_at,
  state: target.operation?.state ?? null,
  kind: target.operation?.kind ?? null,
  reason: target.operation?.reason_code ?? null,
  effect: target.operation?.effect ?? null,
  partIndex: target.operation?.part_index ?? 0,
  outcome: shownOutcome(target.evidence),
  holdReason: target.hold_reason,
});

// A draft target is idle; a target with no operation yet that is waiting for admission is not finished.
const IDLE_SCHEDULE: ReadonlySet<string> = new Set(["draft", "archived", "settled"]);

export function isFinished(target: Target): boolean {
  if (target.presence === "removal_pending") return false;
  if (target.operation === null) return IDLE_SCHEDULE.has(target.schedule_state);
  return TERMINAL.has(target.operation.state);
}

export type Resolution =
  | "attest_published"
  | "attest_not_executed"
  | "supersede"
  | "dismiss"
  | "publish_late"
  | "reschedule"
  | "drop"
  | "confirm_removed";
export type Flavour = "unclear" | "past_due" | "unverified" | "removal";

/**
 * What a person may settle for an operation, derived here because the answer lists only that a resolution exists: the
 * set is the ledger's table of human resolutions by operation state and kind, and the server refuses any other.
 */
export function resolutionsOf(operation: z.infer<typeof operationSchema>): {
  flavour: Flavour;
  kinds: Resolution[];
} {
  const { state, kind, reason_code: reason } = operation;
  if (state === "missed") return { flavour: "past_due", kinds: ["publish_late", "reschedule"] };
  if (state === "unverified") {
    const kinds: Resolution[] = kind === "delete" ? [] : ["attest_published", "supersede"];
    return { flavour: kind === "delete" ? "removal" : "unverified", kinds };
  }
  if (state !== "needs_human") return { flavour: "unclear", kinds: [] };
  if (reason === "past_due_after_reconnect") {
    return { flavour: "past_due", kinds: ["publish_late", "reschedule", "drop"] };
  }
  if (kind === "delete") return { flavour: "removal", kinds: ["confirm_removed", "dismiss"] };
  return {
    flavour: "unclear",
    kinds: ["attest_published", "attest_not_executed", "supersede", "dismiss"],
  };
}

/** What the words and the headline need to know about one target, from a list row or from the detail. */
export interface Facts {
  readonly scheduleState: string;
  readonly presence: string;
  readonly publishedAt: string | null;
  readonly state: string | null;
  readonly kind: string | null;
  readonly reason: string | null;
  readonly effect: string | null;
  readonly partIndex: number;
  readonly outcome: string | null;
  readonly holdReason: string | null;
}

export const factsOfList = (target: ListTarget): Facts => ({
  scheduleState: target.schedule_state,
  presence: target.presence,
  publishedAt: target.published_at,
  state: target.operation_state,
  kind: null,
  reason: null,
  effect: null,
  partIndex: 0,
  outcome: null,
  holdReason: target.hold_reason,
});

export type WordKey =
  | "draft"
  | "pending"
  | "claimed"
  | "processing"
  | "dispatching"
  | "provider_accepted"
  | "retry_wait"
  | "paused"
  | "blocked_reconnect"
  | "unknown_external_state"
  | "reconciling"
  | "needs_human"
  | "needs_human_past_due"
  | "unverified"
  | "published"
  | "published_draft_delivered"
  | "published_scheduled"
  | "failed"
  | "cancelled"
  | "missed"
  | "superseded_after_unknown_outcome"
  | "edit_pending"
  | "edit_failed"
  | "removal_pending"
  | "removed_at_provider"
  | "removal_unknown"
  | "removal_reported"
  | "unknown";

const OPERATION_WORDS: ReadonlySet<string> = new Set([
  "pending",
  "claimed",
  "processing",
  "dispatching",
  "provider_accepted",
  "retry_wait",
  "paused",
  "blocked_reconnect",
  "unknown_external_state",
  "reconciling",
  "needs_human",
  "unverified",
  "failed",
  "cancelled",
  "missed",
  "superseded_after_unknown_outcome",
]);
const PRESENCE_WORDS: ReadonlySet<string> = new Set([
  "removal_pending",
  "removed_at_provider",
  "removal_unknown",
  "removal_reported",
]);
const TERMINAL: ReadonlySet<string> = new Set([
  "published",
  "failed",
  "cancelled",
  "missed",
  "superseded_after_unknown_outcome",
]);
const IN_FLIGHT: ReadonlySet<string> = new Set([
  "claimed",
  "processing",
  "dispatching",
  "provider_accepted",
  "retry_wait",
]);
const ATTENTION: ReadonlySet<string> = new Set([
  "paused",
  "blocked_reconnect",
  "unknown_external_state",
  "reconciling",
  "needs_human",
  "unverified",
]);
const NEEDS_A_PERSON: ReadonlySet<string> = new Set([
  "needs_human",
  "unverified",
  "missed",
  "blocked_reconnect",
  "paused",
]);

function stateWord(facts: Facts, state: string): WordKey {
  if (facts.kind === "edit") {
    if (state === "published") return "published";
    if (TERMINAL.has(state)) return "edit_failed";
    if (!ATTENTION.has(state)) return "edit_pending";
  }
  if (state === "needs_human" && facts.reason === "past_due_after_reconnect") return "needs_human_past_due";
  if (state === "published") {
    if (facts.outcome === "draft_delivered") return "published_draft_delivered";
    return facts.outcome === "scheduled_at_provider" ? "published_scheduled" : "published";
  }
  return OPERATION_WORDS.has(state) ? (state as WordKey) : "unknown";
}

export function wordOf(facts: Facts): WordKey {
  if (PRESENCE_WORDS.has(facts.presence)) return facts.presence as WordKey;
  if (facts.state === null) {
    if (facts.scheduleState === "draft") return "draft";
    return ["scheduled", "approved", "needs_approval"].includes(facts.scheduleState) ? "pending" : "unknown";
  }
  return stateWord(facts, facts.state);
}

export const needsAPerson = (facts: Facts): boolean =>
  (facts.state !== null && NEEDS_A_PERSON.has(facts.state)) || facts.holdReason !== null;

type Class =
  | "attention"
  | "removing"
  | "flight"
  | "waiting"
  | "live"
  | "not_live"
  | "failed"
  | "missed"
  | "removed"
  | "excluded"
  | "draft"
  | "other";

const CLASS_OF_WORD: Partial<Record<WordKey, Class>> = {
  removal_pending: "removing",
  removed_at_provider: "removed",
  removal_reported: "removed",
  cancelled: "excluded",
  superseded_after_unknown_outcome: "excluded",
  edit_pending: "flight",
  published_draft_delivered: "not_live",
  published_scheduled: "not_live",
  pending: "waiting",
  draft: "draft",
  failed: "failed",
  missed: "missed",
};

function classOf(facts: Facts): Class {
  if (facts.state !== null && ATTENTION.has(facts.state)) return "attention";
  const word = wordOf(facts);
  const known = CLASS_OF_WORD[word];
  if (known) return known;
  if (word === "edit_failed" || word === "published") return facts.publishedAt === null ? "other" : "live";
  return facts.state !== null && IN_FLIGHT.has(facts.state) ? "flight" : "other";
}

export type HeadlineKey =
  | "needs_attention"
  | "publishing"
  | "scheduled"
  | "published"
  | "published_not_live"
  | "partially_published"
  | "failed"
  | "missed"
  | "removing"
  | "removed"
  | "draft"
  | "in_review"
  | "changes_requested"
  | "approved"
  | "archived"
  | "unknown";

export interface Headline {
  readonly key: HeadlineKey;
  /** Live posts. */
  readonly n: number;
  /** Targets counted: a cancelled or replaced one is left out. */
  readonly m: number;
  /** Published but not live. */
  readonly k: number;
  /** Targets that need the person, or are being removed. */
  readonly x: number;
  /** Targets that did not go out. */
  readonly f: number;
  /** Targets still waiting. */
  readonly waiting: number;
}

const POST_STATUS_KEYS: ReadonlySet<string> = new Set([
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "partially_published",
  "needs_attention",
  "failed",
  "missed",
  "archived",
]);

const fromStatus = (status: string): HeadlineKey =>
  POST_STATUS_KEYS.has(status) ? (status as HeadlineKey) : "unknown";

function pick(count: (c: Class) => number, counted: number): HeadlineKey | null {
  const done = count("live") + count("not_live");
  if (count("attention") > 0) return "needs_attention";
  if (count("removing") > 0) return "removing";
  if (count("flight") > 0) return "publishing";
  if (count("waiting") > 0) return "scheduled";
  if (counted === 0) return null;
  if (count("live") === counted) return "published";
  if (done === counted) return "published_not_live";
  if (done > 0 && count("failed") + count("missed") > 0) return "partially_published";
  if (done === 0 && count("failed") > 0) return "failed";
  if (count("missed") === counted) return "missed";
  return count("removed") === counted ? "removed" : null;
}

/** The headline rules: the first that matches wins, and Published needs every counted target to be a live post. */
export function headlineOf(status: string, targets: readonly Facts[]): Headline {
  const classes = targets.map(classOf).filter((one) => one !== "excluded");
  const count = (wanted: Class) => classes.filter((one) => one === wanted).length;
  const counted = classes.filter((one) => one !== "draft").length;
  const key = status === "archived" ? "archived" : (pick(count, counted) ?? fromStatus(status));
  return {
    key,
    n: count("live"),
    m: classes.length,
    k: count("not_live"),
    x: count("attention") + count("removing"),
    f: count("failed") + count("missed"),
    waiting: count("waiting"),
  };
}
