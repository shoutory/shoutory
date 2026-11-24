import { manifestSchema } from "./manifest/manifest.js";

export interface NearSunset {
  readonly providerId: string;
  // Absent when the whole provider retires and not one API version.
  readonly version?: string;
  readonly sunset: string;
  readonly daysLeft: number;
}

const DAY_MS = 86_400_000;

// The dated contract test passes the real day, so CI turns red before a provider retires a version.
export function findNearSunsets(manifests: readonly unknown[], today: Date, withinDays = 60): NearSunset[] {
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daysUntil = (sunset: string) => Math.round((Date.parse(`${sunset}T00:00:00Z`) - todayUtc) / DAY_MS);
  const found: NearSunset[] = [];
  for (const candidate of manifests) {
    const manifest = manifestSchema.parse(candidate);
    const dated = [
      ...(manifest.sunset === undefined ? [] : [{ sunset: manifest.sunset }]),
      ...manifest.apiVersions.flatMap(({ version, sunset }) =>
        sunset === undefined ? [] : [{ version, sunset }],
      ),
    ];
    for (const entry of dated) {
      const daysLeft = daysUntil(entry.sunset);
      if (daysLeft <= withinDays) found.push({ providerId: manifest.id, ...entry, daysLeft });
    }
  }
  return found;
}
