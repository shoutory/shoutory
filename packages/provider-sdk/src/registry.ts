import { type Manifest, manifestSchema } from "./manifest/manifest.js";

export interface QueueNames {
  readonly publish: string;
  readonly reconcile: string;
}

export interface Registry {
  readonly manifests: readonly Manifest[];
  queueNames(id: string): QueueNames;
  allQueueNames(): string[];
}

/**
 * Validates every manifest and derives the provider queue names from the manifest ids alone, so the core never names a
 * provider and an id the schema refuses can never become a queue name.
 */
export function createRegistry(input: readonly unknown[]): Registry {
  const manifests = input.map((candidate) => manifestSchema.parse(candidate));
  const byId = new Map<string, QueueNames>();
  for (const { id } of manifests) {
    if (byId.has(id)) throw new Error(`duplicate provider id "${id}"`);
    byId.set(id, { publish: `publish.${id}`, reconcile: `reconcile.${id}` });
  }
  return {
    manifests,
    queueNames(id) {
      const names = byId.get(id);
      if (!names) throw new Error(`no provider "${id}" is registered`);
      return names;
    },
    allQueueNames: () => [...byId.values()].flatMap(({ publish, reconcile }) => [publish, reconcile]),
  };
}
