import type { ErrorCode } from "@shoutory/core/errors";
import { Refusal } from "../errors/refusal.js";

// Their RAISE messages start with `<name> ` or `<name>:`.
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
  "channel_disable",
  "channel_enable",
  "channel_connect",
  "oauth_flow_put",
  "feature_flag_override_set",
  "instance_setting_set",
  "instance_settings_read",
  "resolve_operation",
  // The post definers, and the principal check they share with the media definers (`media: refused`).
  "post",
  "media",
  "media_register",
  "media_mark_uploaded",
  "media_set_multipart",
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
  SH422: "unprocessable_content",
  SH429: "too_many_requests",
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
  "channel_not_connected",
  "media_unavailable",
]);

// A definer that explains its refusal in a sentence instead of a code; the sentence becomes the code a client reads.
const SENTENCES: Readonly<Record<string, string>> = {
  "the channel is not connected, reconnect it first": "channel_not_connected",
};

// `invitation_accept` puts "expires <timestamptz>; invited by <name>" in DETAIL. Only the timestamp is read, by
// this strict pattern; the name is never read, and a DETAIL that does not match gives the reason alone.
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
  const said = message.split(": ")[1];
  const reason = said === undefined ? undefined : (SENTENCES[said] ?? said);
  if (!state.startsWith("SH") || reason === undefined || !REASONS.has(reason)) return undefined;
  const expires = state === "SH410" && reason === "expired" ? expiryOf(detail) : undefined;
  return expires === undefined ? { reason } : { reason, expires_at: expires };
}

// Only the invitation, member, channel, resolution and creation definers raise the SH states, and the attach guard of a
// post (a medium that is no longer ready); the same state under another definer's name is a defect.
const SH_DEFINERS =
  /^(invitation|member|channel)_|^resolve_operation:|^(workspace|organization)_create:|^media_(mark_uploaded|set_multipart):|^post: media_unavailable$/;
const LIMIT_DEFINERS = /^(workspace|organization)_create:/;

// A creation definer's SH429 puts "retry after N seconds" in DETAIL; anything else gives the default Retry-After.
const RETRY_AFTER = /^retry after (\d{1,9}) seconds$/;
const retryAfterOf = (state: string, detail: unknown): number | undefined => {
  const found = state === "SH429" && typeof detail === "string" ? RETRY_AFTER.exec(detail) : null;
  return found ? Number(found[1]) : undefined;
};

export function definerRefusal(error: unknown): Refusal | undefined {
  const { code: state, message, detail } = error as { code?: unknown; message?: unknown; detail?: unknown };
  const code = typeof state === "string" && isDefinerMessage(message) ? DEFINER_STATES[state] : undefined;
  if (!code || typeof state !== "string" || typeof message !== "string") return undefined;
  if (state.startsWith("SH") && !SH_DEFINERS.test(message)) return undefined;
  if (state === "SH429" && !LIMIT_DEFINERS.test(message)) return undefined;
  const details = detailsOf(state, message, detail);
  const retryAfterSeconds = retryAfterOf(state, detail);
  return new Refusal(code, `definer refused: ${state}`, {
    cause: error,
    ...(details ? { details } : {}),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}
