import type { Effect, ProviderResult } from "../result.js";

/** An adapter's mapper from a provider's error answer to a result. */
export type ErrorMapper = (input: {
  readonly status: number;
  readonly body: unknown;
  readonly effect: Effect;
}) => ProviderResult;

export interface ConformanceRow {
  readonly id: string;
  readonly title: string;
  run(mapper: ErrorMapper): void;
}

// Error bodies that carry something shaped like an id, a link or a created object.
const PLANTED = "planted-id-1";
const ERROR_BODIES: readonly unknown[] = [
  { id: PLANTED, error: "duplicate" },
  { data: { id: PLANTED } },
  { uri: `at://${PLANTED}`, code: "conflict" },
  { errors: [{ id: PLANTED }] },
  [PLANTED],
  PLANTED,
  null,
];
const STATUSES = [400, 409, 429, 500] as const;
const EFFECTS: readonly Effect[] = ["none", "possible"];

// What is wrong with an error result, or undefined: an id, a success, or a class that its effect cannot have.
function problemWith(result: ProviderResult): string | undefined {
  const leaked =
    result.externalId !== undefined ||
    result.permalink !== undefined ||
    JSON.stringify(result).includes(PLANTED);
  if (leaked) return "carries an externalId or an id from the body";
  if (result.ok) return "is ok";
  if (result.effect === "confirmed") return "reports a confirmed effect";
  const possibleOnly = result.errorClass === "unknown" || result.errorClass === "retryable_after_send";
  if (result.effect === "possible" && !possibleOnly)
    return "pairs a possible effect with a class that cannot follow it";
  return undefined;
}

function errorResultIsSound(mapper: ErrorMapper): void {
  for (const body of ERROR_BODIES) {
    for (const status of STATUSES) {
      for (const effect of EFFECTS) {
        const problem = problemWith(mapper({ status, body, effect }));
        if (problem) throw new Error(`an error result (status ${status}, effect ${effect}) ${problem}`);
      }
    }
  }
}

export const conformanceRows: readonly ConformanceRow[] = [
  {
    id: "error-result-carries-no-id",
    title: "a provider result built from an error body never carries an externalId",
    run: errorResultIsSound,
  },
];
