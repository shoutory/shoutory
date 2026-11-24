import type { TestProject } from "vitest/node";
import { createTemplate, dropDatabase, readTestEnv } from "../src/testing/template.js";

declare module "vitest" {
  export interface ProvidedContext {
    shoutoryTemplate: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const env = readTestEnv();
  const template = await createTemplate(env);
  project.provide("shoutoryTemplate", template);
  return () => dropDatabase(env, template);
}
