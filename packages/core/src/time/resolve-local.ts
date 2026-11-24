// `automatic` shifts a gap forward and takes the earlier fold; `user` refuses a gap and needs a choice for a fold.
export type ResolvePolicy = "automatic" | { readonly user: "earlier" | "later" | null };

export type Resolution = "unique" | "gap_shifted" | "fold_earlier" | "fold_later";

export type ResolveLocalResult =
  | { readonly ok: true; readonly instant: string; readonly resolution: Resolution }
  | {
      readonly ok: false;
      readonly code: "local_time_nonexistent" | "local_time_ambiguous" | "invalid_zone" | "invalid_local";
    };

// No `:60`: Temporal would quietly read a leap second as `:59`.
const LOCAL_TEXT = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:[0-5]\d)?$/;
// An IANA id: letters, digits and `_ + - /`, never an offset such as `+05:00`.
const ZONE_ID = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

function parseLocal(local: string): Temporal.PlainDateTime | undefined {
  if (!LOCAL_TEXT.test(local)) return undefined;
  try {
    return Temporal.PlainDateTime.from(local);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

function zoneIsKnown(zone: string): boolean {
  if (!ZONE_ID.test(zone)) return false;
  try {
    // Temporal reads any case; only the spelling it reports back is a zone id we accept.
    return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone).timeZoneId === zone;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

const found = (zoned: Temporal.ZonedDateTime, resolution: Resolution): ResolveLocalResult => ({
  ok: true,
  instant: zoned.toInstant().toString(),
  resolution,
});

// The host's own zone is never read: only Temporal's zone data.
export function resolveLocal(local: string, zone: string, policy: ResolvePolicy): ResolveLocalResult {
  const wall = parseLocal(local);
  if (wall === undefined) return { ok: false, code: "invalid_local" };
  if (!zoneIsKnown(zone)) return { ok: false, code: "invalid_zone" };
  const earlier = wall.toZonedDateTime(zone, { disambiguation: "earlier" });
  const later = wall.toZonedDateTime(zone, { disambiguation: "later" });
  if (earlier.epochNanoseconds === later.epochNanoseconds) return found(earlier, "unique");
  // In a fold both instants show the wall time that was asked for; in a gap neither does.
  if (!earlier.toPlainDateTime().equals(wall)) {
    return policy === "automatic"
      ? found(later, "gap_shifted")
      : { ok: false, code: "local_time_nonexistent" };
  }
  const choice = policy === "automatic" ? "earlier" : policy.user;
  if (choice === "earlier") return found(earlier, "fold_earlier");
  return choice === "later" ? found(later, "fold_later") : { ok: false, code: "local_time_ambiguous" };
}
