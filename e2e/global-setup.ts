import { mkdirSync } from "node:fs";
import { flagRemovalDate, REMOVE_BY_VARIABLE, STATE_DIR, startStack } from "./support/stack";

/** One stack per run: started here, found by the specs through the environment, removed by the returned teardown. */
export default function globalSetup(): () => void {
  mkdirSync(STATE_DIR, { recursive: true });
  const removeBy = flagRemovalDate();
  const stack = startStack(removeBy);
  process.env.SHOUTORY_E2E_MAIL_URL = stack.mailUrl;
  process.env.SHOUTORY_E2E_PROJECT = stack.project;
  process.env[REMOVE_BY_VARIABLE] = removeBy;
  // The restore drill runs compose itself, so it alone gets the stack's environment (its secrets stay in this run).
  if (process.env.SHOUTORY_E2E_RESTORE === "true") {
    for (const [name, value] of Object.entries(stack.env)) {
      if (name.startsWith("SHOUTORY_") && value !== undefined) process.env[name] = value;
    }
  }
  return () => stack.down();
}
