import { mkdirSync } from "node:fs";
import { STATE_DIR, startStack } from "./support/stack";

/** One stack per run: started here, found by the specs through the environment, removed by the returned teardown. */
export default function globalSetup(): () => void {
  mkdirSync(STATE_DIR, { recursive: true });
  const stack = startStack();
  process.env.SHOUTORY_E2E_MAIL_URL = stack.mailUrl;
  return () => stack.down();
}
