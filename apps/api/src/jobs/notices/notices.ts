import type { TenantTx } from "@shoutory/db/context";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { Logger } from "../../logging/logger.js";

// The most candidates one tick takes; the rest wait for the next tick.
const BATCH = 200;
const ESCALATING = new Set(["needs_human", "unverified"]);

interface Candidate {
  readonly kind: string;
  readonly workspace_id: string;
  readonly subject_id: string;
  readonly level: string;
  readonly step: number;
  readonly vars: Record<string, unknown>;
}

// One candidate is one transaction: the reminder of an unclear post moves first, then every recipient's notice is
// written with its mail. The definers write a notice only once per level, so a crash or a second job repeats nothing.
async function notify(tx: TenantTx, candidate: Candidate): Promise<number> {
  if (ESCALATING.has(candidate.kind)) {
    const moved = await tx.query<{ moved: boolean }>(
      "SELECT app.notice_escalation_advance($1, $2, $3) AS moved",
      [candidate.workspace_id, candidate.subject_id, candidate.step],
    );
    if (!moved.rows[0]?.moved) return 0;
  }
  const recipients = await tx.query<{ user_id: string }>(
    "SELECT user_id FROM app.notice_recipients($1, $2, $3)",
    [candidate.workspace_id, candidate.kind, candidate.subject_id],
  );
  let created = 0;
  for (const { user_id: userId } of recipients.rows) {
    const made = await tx.query<{ made: boolean }>(
      "SELECT app.notice_create($1, $2, $3, $4, $5, $6::jsonb) AS made",
      [
        candidate.workspace_id,
        userId,
        candidate.kind,
        candidate.subject_id,
        candidate.level,
        JSON.stringify(candidate.vars),
      ],
    );
    if (made.rows[0]?.made) created += 1;
  }
  return created;
}

export interface NoticeJobOptions {
  readonly pool: AppPool;
  readonly logger: Logger;
}

// Sends what the six notice kinds have due. A candidate that fails is logged by id and kind and the others go on.
export async function sendDueNotices({ pool, logger }: NoticeJobOptions): Promise<number> {
  const due = await withSystem(pool, "ledger", (tx) =>
    tx.query<Candidate>("SELECT * FROM app.notice_candidates($1)", [BATCH]),
  );
  let created = 0;
  for (const candidate of due.rows) {
    try {
      created += await withSystem(pool, "ledger", (tx) => notify(tx, candidate));
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      logger.error(
        {
          kind: candidate.kind,
          subject: candidate.subject_id,
          error: error instanceof Error ? error.name : "NonError",
          ...(typeof code === "string" ? { code } : {}),
        },
        "notice failed",
      );
    }
  }
  return created;
}
