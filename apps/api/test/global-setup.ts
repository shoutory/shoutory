import { readTestEnv, withDatabase } from "@shoutory/db/testing";
import type { TestProject } from "vitest/node";
import { installJobs } from "../src/cli/migrate.js";

// Runs after the db package's setup: the template database it built gets the job queue's schema, once, so every clone
// has it (`shoutory migrate` does the same on a real database). The db package never imports the api.
export default async function setup(project: TestProject): Promise<void> {
  const template = project.getProvidedContext().shoutoryTemplate;
  await installJobs(withDatabase(readTestEnv().roleUrls.owner, template));
}
