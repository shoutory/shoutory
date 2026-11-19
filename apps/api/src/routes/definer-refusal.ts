import type { ErrorCode } from "@shoutory/core/errors";
import { Refusal } from "../errors/refusal.js";

// The definers a user route calls: their RAISE messages (migrations 0009 and 0010) start with `<name> ` or `<name>:`.
const DEFINERS = [
  "resolve_workspace_access",
  "my_workspaces",
  "my_organizations",
  "organization_create",
  "workspace_create",
  "invitation_create",
  "invitation_revoke",
  "invitation_accept",
  "member_role_set",
  "member_remove",
  "feature_flag_override_set",
  "instance_setting_set",
  "instance_settings_read",
];
const isDefinerMessage = (message: unknown): message is string =>
  typeof message === "string" &&
  DEFINERS.some((name) => message.startsWith(`${name} `) || message.startsWith(`${name}:`));

// The definers' own refusals, answered after the transaction has rolled back. Any other state, and the same state
// under another message (a revoked grant or a row-security refusal is also 42501), propagates as a defect.
const DEFINER_STATES: Readonly<Record<string, ErrorCode>> = {
  "42501": "not_found",
  "22023": "validation_failed",
  "54000": "limit_reached",
  "53400": "limit_reached",
  SH403: "forbidden",
  SH409: "conflict",
  SH410: "invitation_unusable",
};

// The reason codes a definer puts after its name (`invitation_accept: expired`); any other text is never sent on.
const REASONS: ReadonlySet<string> = new Set([
  "email_mismatch",
  "email_unverified",
  "already_member",
  "pending_duplicate",
  "already_ended",
  "last_owner",
  "already_owner",
  "used",
  "revoked",
  "expired",
]);

// `invitation_accept` puts "expires <timestamptz>; invited by <name>" in DETAIL (R241). Only the timestamp is read, by
// this strict pattern; the name is never read (R263), and a DETAIL that does not match gives the reason alone.
const EXPIRY =
  /^expires (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?([+-]\d{2})(?::(\d{2}))?; invited by /s;

function expiryOf(detail: unknown): string | undefined {
  const found = typeof detail === "string" ? EXPIRY.exec(detail) : null;
  if (!found) return undefined;
  const [, day, time, hours, minutes] = found;
  const at = new Date(`${day}T${time}${hours}:${minutes ?? "00"}`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

function detailsOf(state: string, message: string, detail: unknown): Record<string, string> | undefined {
  const reason = message.split(": ")[1];
  if (!state.startsWith("SH") || reason === undefined || !REASONS.has(reason)) return undefined;
  const expires = state === "SH410" && reason === "expired" ? expiryOf(detail) : undefined;
  return expires === undefined ? { reason } : { reason, expires_at: expires };
}

// Only the invitation and member definers raise the SH states; the same state under another definer's name is a defect.
const SH_DEFINERS = /^(invitation|member)_/;

/** The refusal a definer's own error answers with, or nothing when the error is not one of its refusals. */
export function definerRefusal(error: unknown): Refusal | undefined {
  const { code: state, message, detail } = error as { code?: unknown; message?: unknown; detail?: unknown };
  const code = typeof state === "string" && isDefinerMessage(message) ? DEFINER_STATES[state] : undefined;
  if (!code || typeof state !== "string" || typeof message !== "string") return undefined;
  if (state.startsWith("SH") && !SH_DEFINERS.test(message)) return undefined;
  const details = detailsOf(state, message, detail);
  return new Refusal(code, `definer refused: ${state}`, { cause: error, ...(details ? { details } : {}) });
}
