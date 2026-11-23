import { createHash } from "node:crypto";
import type { Manifest } from "./manifest/manifest.js";

const dayStart = (date: string): Date => new Date(`${date}T00:00:00Z`);

// The newest version by its introduction date whose sunset has not passed; the newest of all when every one has.
function versionInForce(manifest: Manifest, now: Date) {
  const newestFirst = [...manifest.apiVersions].sort((a, b) => (a.introduced < b.introduced ? 1 : -1));
  return newestFirst.find((v) => v.sunset === undefined || dayStart(v.sunset) > now) ?? newestFirst[0];
}

/**
 * Whether the provider's API has retired at `now`: the manifest itself has a sunset date that has come, or the version in
 * force is past its own sunset (which is only so when every version is). A sunset takes effect at 00:00 UTC of its date.
 */
export function pastSunset(manifest: Manifest, now: Date): boolean {
  if (manifest.sunset !== undefined && dayStart(manifest.sunset) <= now) return true;
  const sunset = versionInForce(manifest, now)?.sunset;
  return sunset !== undefined && dayStart(sunset) <= now;
}

/**
 * The capability snapshot of a channel: a digest of the parsed manifest (its keys come out of the schema in one fixed
 * order), the API version in force at `now` (the newest by its
 * introduction date whose sunset has not passed; the newest of all when every one has) with its sunset date, and the
 * capabilities and limits as the manifest lists them. The clock is an input.
 */
export function snapshotOf(manifest: Manifest, now: Date) {
  const version = versionInForce(manifest, now);
  return {
    manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    apiVersion: version?.version ?? "none",
    sunsetAt: version?.sunset === undefined ? null : dayStart(version.sunset),
    capabilities: manifest.capabilities,
    limits: manifest.limits,
  };
}
