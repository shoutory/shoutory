import type { Permission } from "@shoutory/core/authz";
import { STEP_UP_KINDS } from "../operations/operations.js";

// What a person may do with one target of a post, decided here and sent with the answer, so a screen never works it out.
export type TargetAction =
  | "schedule"
  | "publish_now"
  | "unschedule"
  | "cancel"
  | "resolve"
  | "edit"
  | "delete"
  | "duplicate";

export interface ActionFacts {
  readonly scheduleState: string;
  readonly presence: string;
  readonly publishedAt: Date | null;
  readonly operation: { readonly state: string; readonly effect: string } | null;
  readonly postAuthorId: string | null;
  readonly principalId: string;
  readonly permissions: ReadonlySet<Permission>;
  /** What the channel's provider can do; absent when no adapter serves it. */
  readonly provider:
    | {
        readonly capabilities: readonly string[];
        readonly editWindowSeconds?: number;
        readonly deleteWindowSeconds?: number;
      }
    | undefined;
  readonly now: Date;
}

const TERMINAL: ReadonlySet<string> = new Set([
  "published",
  "failed",
  "cancelled",
  "missed",
  "superseded_after_unknown_outcome",
]);
const WAITING: ReadonlySet<string> = new Set(["pending", "retry_wait", "paused", "blocked_reconnect"]);
const NEEDS_PERSON: ReadonlySet<string> = new Set(["needs_human", "unverified", "missed"]);

function publishedActions(facts: ActionFacts, busy: boolean): TargetAction[] {
  if (facts.publishedAt === null || busy) return [];
  const capabilities = facts.provider?.capabilities ?? [];
  const closesAt = facts.publishedAt.getTime();
  const inWindow = (window: number | undefined) =>
    window === undefined || facts.now.getTime() <= closesAt + window * 1000;
  const present = facts.presence === "present";
  return [
    ...(present && inWindow(facts.provider?.editWindowSeconds) && capabilities.includes("edit")
      ? (["edit"] as const)
      : []),
    ...(present && inWindow(facts.provider?.deleteWindowSeconds) && capabilities.includes("delete")
      ? (["delete"] as const)
      : []),
  ];
}

export interface ResolutionFacts {
  readonly state: string;
  readonly kind: string;
  readonly reason_code: string | null;
  readonly effect: string;
}

export interface Resolution {
  readonly kind: string;
  readonly step_up: boolean;
}

// What the resolve route accepts for an operation, by its state, kind and effect: the ledger's table of human
// resolutions. A send needs that nothing was sent, since the screen offers no absence evidence.
function resolutionKinds(op: ResolutionFacts): readonly string[] {
  const unsent = op.effect === "none";
  if (op.state === "missed") return unsent ? ["publish_late", "reschedule"] : [];
  if (op.state === "unverified") return op.kind === "delete" ? [] : ["attest_published", "supersede"];
  if (op.state !== "needs_human") return [];
  if (op.reason_code === "past_due_after_reconnect") {
    return unsent ? ["publish_late", "reschedule", "drop"] : [];
  }
  if (op.kind === "delete") return ["confirm_removed", "dismiss"];
  return ["attest_published", "attest_not_executed", "supersede", "dismiss"];
}

/** The resolutions this person may make for the operation, each with whether the route asks for a fresh password. */
export function resolutionsOf(op: ResolutionFacts, mayAct: boolean): Resolution[] {
  if (!mayAct) return [];
  return resolutionKinds(op).map((kind) => ({ kind, step_up: STEP_UP.has(kind) }));
}

const STEP_UP: ReadonlySet<string> = new Set(STEP_UP_KINDS);

function operationActions(facts: ActionFacts, mayAct: boolean): TargetAction[] {
  const op = facts.operation;
  if (op === null || !mayAct) return [];
  if (WAITING.has(op.state) && op.effect === "none") return ["cancel"];
  return NEEDS_PERSON.has(op.state) ? ["resolve"] : [];
}

// The cancel and resolve rules are the Owner's and Admin's, or the author's own.
export const mayResolve = (facts: Pick<ActionFacts, "permissions" | "postAuthorId" | "principalId">): boolean =>
  facts.permissions.has("publish.resolve") || facts.postAuthorId === facts.principalId;

export function targetActions(facts: ActionFacts): TargetAction[] {
  if (!facts.permissions.has("posts.edit")) return [];
  const op = facts.operation;
  const busy = op !== null && !TERMINAL.has(op.state);
  const mayAct = mayResolve(facts);
  const draftSide: TargetAction[] =
    facts.scheduleState === "draft"
      ? ["schedule", "publish_now"]
      : facts.scheduleState === "scheduled"
        ? ["schedule", "publish_now", "unschedule"]
        : [];
  return [...draftSide, ...operationActions(facts, mayAct), ...publishedActions(facts, busy), "duplicate"];
}
