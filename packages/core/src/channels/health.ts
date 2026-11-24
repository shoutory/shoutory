export type Health = "ok" | "degraded" | "failing";

// A read that cannot be confirmed is not evidence of failure, so only a confirmed refusal is `failing`.
export function healthOf(result: {
  readonly ok: boolean;
  readonly health?: "ok" | "degraded" | undefined;
  readonly errorClass?: string | undefined;
}): Health {
  if (result.ok) return result.health ?? "ok";
  return result.errorClass === "auth_revoked" || result.errorClass === "permanent" ? "failing" : "degraded";
}
