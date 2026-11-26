import { resolveLocal } from "@shoutory/core/time";
import type { TenantTx } from "@shoutory/db/context";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import { type App, defineRoute } from "../define-route.js";
import { definerRefusal } from "../definer-refusal.js";

// The definer `resolve_operation` is the authority on rank and on the post's author; the workspace access
// only narrows the transaction, which lets the audit row be written with the resolution in the same transaction.

const uuid = z.uuid().transform((id) => id.toLowerCase());
const params = z.strictObject({ workspace_id: uuid, operation_id: uuid });

const STEP_UP_KINDS = ["attest_published", "attest_not_executed", "supersede", "confirm_removed"] as const;
const SESSION_KINDS = ["publish_late", "reschedule", "drop", "dismiss"] as const;
const NEEDS_ACK: readonly string[] = ["attest_not_executed", "supersede"];

// Text the database can keep: no NUL (a text column refuses it) and no half of a character (it cannot be stored as UTF-8).
const plain = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => !text.includes("\0") && text.isWellFormed(), "the text is not readable");

const detail = {
  ack_text: plain(2000).min(1).optional(),
  note: plain(2000).optional(),
  // Text the person saw, stored with the evidence and never fetched: an https link with no spaces, not a URL field of
  // the egress list.
  permalink: plain(2048)
    .regex(/^https:\/\/\S+$/, "an https link")
    .refine((link) => URL.canParse(link), "a link that parses")
    .optional(),
  absence_evidence_id: z.uuid().optional(),
  // Only a reschedule takes a new local time; a fold in it needs the person's choice.
  local_due: z.string().max(32).optional(),
  fold: z.enum(["earlier", "later"]).optional(),
};
const bodyOf = <K extends readonly [string, ...string[]]>(kinds: K) =>
  z
    .strictObject({ kind: z.enum(kinds), ...detail })
    .refine((body) => !NEEDS_ACK.includes(body.kind) || body.ack_text !== undefined, {
      message: "this kind needs ack_text",
      path: ["ack_text"],
    });

type IpHmac = (address: string) => Buffer;

// The resolution row names the absence evidence by a foreign key; an id no evidence of the workspace has fails it, which is
// the caller's bad input. Matched by the constraint's own name: any other 23503 stays a defect.
const ABSENCE_FK = "operation_resolutions_workspace_id_absence_evidence_id_fkey";
function unknownEvidence(error: unknown): Refusal | undefined {
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === "23503" && constraint === ABSENCE_FK
    ? new Refusal("validation_failed", "the absence evidence id is not known", { cause: error })
    : undefined;
}

const refusedTime = (reason: string) =>
  new Refusal("unprocessable_content", `reschedule refused: ${reason}`, { details: { reason } });

// A reschedule names its new wall time and the workspace's zone gives the instant; the database refuses an instant
// that is not ahead. Any other kind takes no time.
async function newTime(
  tx: TenantTx,
  workspaceId: string,
  kind: string,
  localDue: string | undefined,
  fold: "earlier" | "later" | undefined,
): Promise<Record<string, string>> {
  if (kind !== "reschedule") {
    if (localDue !== undefined || fold !== undefined) throw refusedTime("local_due_not_allowed");
    return {};
  }
  if (localDue === undefined) throw refusedTime("local_due_required");
  const { rows } = await tx.query<{ default_tz: string }>(
    "SELECT default_tz FROM app.workspaces WHERE id = $1",
    [workspaceId],
  );
  const zone = rows[0]?.default_tz ?? "UTC";
  const resolved = resolveLocal(localDue, zone, { user: fold ?? null });
  if (!resolved.ok) throw refusedTime(resolved.code);
  return { local_due: localDue, due_tz: zone, due_at: resolved.instant };
}

function registerResolve<K extends readonly [string, ...string[]]>(
  app: App,
  ipHmac: IpHmac,
  route: { path: string; policy: "session" | "step_up"; kinds: K },
): void {
  defineRoute(app, {
    method: "post",
    path: route.path,
    policy: route.policy,
    access: { workspace: "workspace_id", permission: "posts.edit" },
    params,
    body: bodyOf(route.kinds),
    handler: async ({ c, tx, scope, params: ids, body, clientAddress }) => {
      const { kind, local_due: localDue, fold, ...rest } = body;
      const args = { ...rest, ...(await newTime(tx, scope.workspaceId, kind, localDue, fold)) };
      try {
        const done = await tx.query("SELECT * FROM app.resolve_operation($1, $2, $3, $4::jsonb)", [
          scope.workspaceId,
          ids.operation_id,
          kind,
          JSON.stringify(args),
        ]);
        const made: string | null = done.rows[0]?.new_operation_id ?? null;
        // Ids only: the text of the person never reaches the audit log.
        await tx.query("SELECT app.audit_insert('operation.resolved', 'operation', $1, $2, $3, $4::jsonb)", [
          ids.operation_id,
          c.get("requestId"),
          ipHmac(clientAddress),
          JSON.stringify({ kind, new_operation_id: made }),
        ]);
        return { operation_id: ids.operation_id, kind, new_operation_id: made };
      } catch (error) {
        throw definerRefusal(error) ?? unknownEvidence(error) ?? error;
      }
    },
  });
}

const BASE = "/api/v1/workspaces/{workspace_id}/operations/{operation_id}/resolutions";

export function registerOperations(app: App, ipHmac: IpHmac): void {
  registerResolve(app, ipHmac, { path: BASE, policy: "session", kinds: SESSION_KINDS });
  registerResolve(app, ipHmac, { path: `${BASE}/confirmed`, policy: "step_up", kinds: STEP_UP_KINDS });
}
