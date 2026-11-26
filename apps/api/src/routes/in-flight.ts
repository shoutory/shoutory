import { Refusal } from "../errors/refusal.js";

const RETRY_AFTER_SECONDS = 5;

/**
 * A memory bound for work that holds a whole file in this process: two at a time, whoever asks, and a third is told to
 * try again shortly. Fairness between workspaces or users belongs to the rate limits, not to this.
 */
export function inFlightLimit(max: number, busy: string): () => () => void {
  let running = 0;
  return () => {
    if (running >= max)
      throw new Refusal("too_many_requests", busy, { retryAfterSeconds: RETRY_AFTER_SECONDS });
    running++;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      running--;
    };
  };
}
