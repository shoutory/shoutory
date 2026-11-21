/** A channel's observed health (the closed set of the channel row). */
export type Health = "ok" | "degraded" | "failing";

/**
 * What a read of a channel says of its health. A read that cannot be confirmed is not evidence of failure: a limit, a
 * cut-off or an unknown answer is `degraded`, and only a refusal the provider confirmed (`auth_revoked`, `permanent`) is
 * `failing`. Nothing here names a connection state: only the refresh service's confirmed revocation moves one.
 */
export function healthOf(result: {
  readonly ok: boolean;
  readonly health?: "ok" | "degraded" | undefined;
  readonly errorClass?: string | undefined;
}): Health {
  if (result.ok) return result.health ?? "ok";
  return result.errorClass === "auth_revoked" || result.errorClass === "permanent" ? "failing" : "degraded";
}
