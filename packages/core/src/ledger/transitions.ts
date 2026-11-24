// The database refuses any move not in this table; its seed must equal it, which a test compares.

export const LEDGER_STATES = [
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
  "published",
  "failed",
  "cancelled",
  "missed",
  "superseded_after_unknown_outcome",
] as const;
export type LedgerState = (typeof LEDGER_STATES)[number];

// Scheduler, worker, poller, reconciler, evidence, user, sweeper.
export const LEDGER_ACTORS = ["S", "W", "P", "R", "E", "U", "X"] as const;
export type LedgerActor = (typeof LEDGER_ACTORS)[number];

// A terminal state frees the target's slot for the next operation.
export const TERMINAL_STATES: readonly LedgerState[] = [
  "published",
  "failed",
  "cancelled",
  "missed",
  "superseded_after_unknown_outcome",
];

export interface LedgerTransition {
  readonly row: number;
  readonly from: LedgerState | "none";
  readonly to: LedgerState;
  readonly actor: LedgerActor;
  readonly guard: string;
  readonly bumpsFence: boolean;
}

const NON_TERMINAL = LEDGER_STATES.filter((state) => !TERMINAL_STATES.includes(state));

type Moving = readonly (LedgerState | "none")[];
type Spec = readonly [
  row: number,
  from: Moving,
  to: readonly LedgerState[],
  actors: readonly LedgerActor[],
  guard: string,
  bumpedBy?: readonly LedgerActor[],
];

const CANCELLABLE: Moving = ["pending", "claimed", "processing", "retry_wait", "paused", "blocked_reconnect"];
const HELD: Moving = ["claimed", "processing", "provider_accepted", "unknown_external_state", "reconciling"];

// A row that lists several from-states, to-states or actors makes one move for every combination. `bumpedBy` names the
// actors whose move raises the fencing token, so a worker holding the old one loses its next write.
const ROWS: readonly Spec[] = [
  [1, ["none"], ["pending"], ["S"], "admit_free_slot"],
  [2, ["none"], ["missed"], ["S"], "late_at_admission"],
  [3, ["none"], ["blocked_reconnect", "paused"], ["S"], "channel_unavailable"],
  [4, ["pending"], ["claimed"], ["W"], "due_in_window", ["W"]],
  [5, ["pending", "retry_wait", "paused"], ["missed"], ["S"], "late_effect_none"],
  [6, ["pending", "retry_wait"], ["paused"], ["S", "W"], "pause_reason"],
  [7, ["pending", "retry_wait", "paused"], ["blocked_reconnect"], ["S"], "channel_left"],
  [8, CANCELLABLE, ["cancelled"], ["U"], "cancel_effect_none", ["U"]],
  [9, ["claimed"], ["dispatching"], ["W"], "prepare_done"],
  [10, ["claimed"], ["pending"], ["X", "W"], "lease_expired_or_drain", ["X"]],
  [11, ["claimed"], ["processing"], ["W"], "provider_preparing"],
  [12, ["claimed"], ["retry_wait", "paused", "failed"], ["W"], "prepare_failure"],
  [13, HELD, ["blocked_reconnect"], ["W", "P", "R"], "revocation_confirmed"],
  [14, ["processing"], ["dispatching"], ["P"], "media_ready"],
  [15, ["processing"], ["retry_wait"], ["P", "X"], "processing_failed_retryable", ["X"]],
  [16, ["processing"], ["failed"], ["P", "S"], "processing_rejected"],
  [17, ["dispatching"], ["published"], ["W"], "receipt"],
  [18, ["dispatching"], ["provider_accepted"], ["W"], "async_accept"],
  [19, ["dispatching"], ["retry_wait"], ["W"], "no_effect_retry"],
  [20, ["dispatching"], ["failed"], ["W"], "no_effect_permanent"],
  [21, ["dispatching"], ["paused"], ["W"], "no_effect_cooldown"],
  [22, ["dispatching"], ["unknown_external_state"], ["W", "X"], "outcome_unknown", ["X"]],
  [23, ["provider_accepted"], ["published"], ["P", "E"], "poll_or_webhook"],
  [24, ["provider_accepted"], ["failed"], ["P"], "terminal_failure_absent"],
  [25, ["provider_accepted"], ["unknown_external_state"], ["P"], "poll_deadline_passed"],
  [26, ["retry_wait"], ["pending"], ["S"], "retry_due"],
  [27, ["retry_wait"], ["failed"], ["S"], "attempts_exhausted"],
  [28, ["paused"], ["pending"], ["S"], "reason_cleared"],
  [29, ["blocked_reconnect"], ["pending"], ["S"], "reconnected_in_window"],
  [30, ["blocked_reconnect"], ["needs_human"], ["S"], "reconnected_late"],
  [
    31,
    ["blocked_reconnect"],
    ["unknown_external_state", "provider_accepted"],
    ["S"],
    "reconnected_effect_kept",
  ],
  [32, ["blocked_reconnect"], ["cancelled"], ["S"], "reconnect_deadline_passed"],
  [33, ["unknown_external_state"], ["reconciling"], ["R"], "claim_reconcile", ["R"]],
  [34, ["unknown_external_state"], ["needs_human"], ["R"], "class_e_human", ["R"]],
  [35, ["reconciling"], ["published"], ["R"], "read_back_found"],
  [36, ["reconciling"], ["retry_wait"], ["R"], "absence_proven"],
  [37, ["reconciling"], ["unknown_external_state"], ["R", "X"], "inconclusive_or_lease_expired", ["X"]],
  [38, ["reconciling"], ["needs_human"], ["R"], "ambiguous_or_unprovable"],
  [39, ["reconciling", "unknown_external_state"], ["unverified"], ["R", "S"], "unverified_horizon"],
  [40, NON_TERMINAL, ["published"], ["E"], "receipt_evidence", ["E"]],
  [41, ["needs_human", "unverified"], ["published"], ["U"], "attest_published"],
  [42, ["needs_human"], ["retry_wait"], ["U"], "attest_not_executed"],
  [43, ["needs_human"], ["retry_wait"], ["U"], "publish_late"],
  [44, ["needs_human"], ["cancelled"], ["U"], "drop_or_reschedule"],
  [45, ["needs_human"], ["unverified"], ["U"], "dismiss"],
  [46, ["needs_human", "unverified"], ["superseded_after_unknown_outcome"], ["U"], "supersede"],
  [47, ["superseded_after_unknown_outcome"], ["superseded_after_unknown_outcome"], ["E"], "late_evidence"],
  [48, CANCELLABLE, ["cancelled"], ["S"], "policy_cancel", ["S"]],
  [49, ["provider_accepted"], ["needs_human"], ["S"], "awaiting_user_timeout"],
  [50, ["none"], ["pending"], ["U"], "user_insert"],
  [51, ["claimed"], ["needs_human"], ["W"], "media_unreachable"],
];

export const LEDGER_TRANSITIONS: readonly LedgerTransition[] = ROWS.flatMap(
  ([row, froms, tos, actors, guard, bumpedBy = []]) =>
    froms.flatMap((from) =>
      tos.flatMap((to) =>
        actors.map((actor) => ({ row, from, to, actor, guard, bumpsFence: bumpedBy.includes(actor) })),
      ),
    ),
);
