import type { Permission } from "@shoutory/core/authz";

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
    | { readonly capabilities: readonly string[]; readonly editWindowSeconds?: number }
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
  const window = facts.provider?.editWindowSeconds;
  const inWindow = window === undefined || facts.now.getTime() <= facts.publishedAt.getTime() + window * 1000;
  const present = facts.presence === "present";
  return [
    ...(present && inWindow && capabilities.includes("edit") ? (["edit"] as const) : []),
    ...(present && capabilities.includes("delete") ? (["delete"] as const) : []),
  ];
}

function operationActions(facts: ActionFacts, mayAct: boolean): TargetAction[] {
  const op = facts.operation;
  if (op === null || !mayAct) return [];
  if (WAITING.has(op.state) && op.effect === "none") return ["cancel"];
  return NEEDS_PERSON.has(op.state) ? ["resolve"] : [];
}

export function targetActions(facts: ActionFacts): TargetAction[] {
  if (!facts.permissions.has("posts.edit")) return [];
  const op = facts.operation;
  const busy = op !== null && !TERMINAL.has(op.state);
  // The cancel and resolve rules are the Owner's and Admin's, or the author's own.
  const mayAct = facts.permissions.has("publish.resolve") || facts.postAuthorId === facts.principalId;
  const draftSide: TargetAction[] =
    facts.scheduleState === "draft"
      ? ["schedule", "publish_now"]
      : facts.scheduleState === "scheduled"
        ? ["schedule", "publish_now", "unschedule"]
        : [];
  return [...draftSide, ...operationActions(facts, mayAct), ...publishedActions(facts, busy), "duplicate"];
}
