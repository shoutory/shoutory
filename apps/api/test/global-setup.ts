import type { TestProject } from "vitest/node";
import { installJobs } from "../src/jobs/install.js";

export const QUEUE_NAMES = ["publish.fixture", "reconcile.fixture"];

// A global setup is loaded outside the `source` resolve condition of the test projects, so this file and what it
// imports use relative paths and third-party packages only: a workspace import would need a built `dist`, which a
// clean checkout does not have.
export default async function setup(project: TestProject): Promise<void> {
  const owner = process.env.SHOUTORY_DATABASE_URL_OWNER;
  if (!owner) throw new Error("SHOUTORY_DATABASE_URL_OWNER is not set");
  const url = new URL(owner);
  url.pathname = `/${project.getProvidedContext().shoutoryTemplate}`;
  await installJobs(url.toString(), QUEUE_NAMES);
}
