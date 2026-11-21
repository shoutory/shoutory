import { createHash } from "node:crypto";
import type { Manifest } from "./manifest/manifest.js";

/**
 * The capability snapshot of a channel: a digest of the parsed manifest (its keys come out of the schema in one fixed
 * order), the API version in force at `now` (the newest by its
 * introduction date whose sunset has not passed; the newest of all when every one has) with its sunset date, and the
 * capabilities and limits as the manifest lists them. The clock is an input.
 */
export function snapshotOf(manifest: Manifest, now: Date) {
  const newestFirst = [...manifest.apiVersions].sort((a, b) => (a.introduced < b.introduced ? 1 : -1));
  const inForce = newestFirst.find((v) => v.sunset === undefined || new Date(`${v.sunset}T00:00:00Z`) > now);
  const version = inForce ?? newestFirst[0];
  return {
    manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    apiVersion: version?.version ?? "none",
    sunsetAt: version?.sunset === undefined ? null : new Date(`${version.sunset}T00:00:00Z`),
    capabilities: manifest.capabilities,
    limits: manifest.limits,
  };
}
