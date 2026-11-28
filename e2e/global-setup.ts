import { mkdirSync } from "node:fs";
import { prepareSimulators, publishSimulators, removeSimulatorFiles } from "./fixtures/simulators";
import { flagRemovalDate, REMOVE_BY_VARIABLE, STATE_DIR, type Stack, startStack } from "./support/stack";

export default async function globalSetup(): Promise<() => void> {
  mkdirSync(STATE_DIR, { recursive: true });
  const removeBy = flagRemovalDate();
  const files = await prepareSimulators();
  let stack: Stack | undefined;
  try {
    stack = startStack(removeBy, files.env);
    process.env.SHOUTORY_E2E_MAIL_URL = stack.mailUrl;
    process.env.SHOUTORY_E2E_PROJECT = stack.project;
    process.env[REMOVE_BY_VARIABLE] = removeBy;
    publishSimulators(files, stack.simulatorPort);
    // The restore drill runs compose itself, so it alone gets the stack's secrets.
    if (process.env.SHOUTORY_E2E_RESTORE === "true") {
      for (const [name, value] of Object.entries(stack.env)) {
        if (name.startsWith("SHOUTORY_") && value !== undefined) process.env[name] = value;
      }
    }
    const started = stack;
    return () => {
      started.down();
      removeSimulatorFiles(files);
    };
  } catch (error) {
    stack?.down();
    removeSimulatorFiles(files);
    throw error;
  }
}
