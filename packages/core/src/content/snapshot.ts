import { createHash } from "node:crypto";
import { z } from "zod";
import { type Draft, jsonbBytes, targetOf } from "./document.js";

// The hash is taken over canonical JSON and never from the `jsonb` text, which reorders keys.

const MAX_SNAPSHOT_BYTES = 1_048_576;

const resolvedSchema = z.strictObject({
  variants: z.array(
    z.strictObject({
      channel_id: z.guid(),
      // Matched to the draft by key only, so it takes no bound of its own.
      locale: z.string().nullable(),
      settings: z.record(z.string(), z.unknown()),
    }),
  ),
  media: z.record(z.guid(), z.string().regex(/^[0-9a-f]{64}$/)),
  manifestDigest: z.record(z.guid(), z.string().min(1).max(256)),
});

export type Resolved = z.infer<typeof resolvedSchema>;

export interface Snapshot {
  version: 1;
  draft: Draft;
  resolved: Resolved;
}

function canonicalObject(value: object): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("canonical JSON takes plain objects only");
  const members = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${members.join(",")}}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  // `Array.from` visits holes as undefined, which is refused; `map` would skip them and print invalid JSON.
  if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") return canonicalObject(value);
  throw new Error(
    `canonical JSON refuses ${typeof value === "number" ? "a number that is not a safe integer" : typeof value}`,
  );
}

export type BuildResult =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly code: "snapshot_too_large" };

// A snapshot over 1 MiB is a result the caller can answer (the user wrote the content). A malformed or mismatched
// resolved block is a defect of the server, which builds it, so it throws.
export function buildSnapshot(draft: Draft, resolved: Resolved): BuildResult {
  const checked = resolvedSchema.parse(resolved);
  const wanted = new Set(draft.variants.map(targetOf));
  const given = new Set(checked.variants.map(targetOf));
  if (checked.variants.length !== wanted.size || ![...wanted].every((target) => given.has(target)))
    throw new Error("the resolved block does not match the variants of the draft");
  const snapshot: Snapshot = { version: 1, draft, resolved: checked };
  const bytes = jsonbBytes(snapshot, Number.POSITIVE_INFINITY);
  if (bytes === undefined) throw new Error("a snapshot holds plain JSON only");
  return bytes > MAX_SNAPSHOT_BYTES ? { ok: false, code: "snapshot_too_large" } : { ok: true, snapshot };
}

export function snapshotHash(snapshot: Snapshot): Buffer {
  return createHash("sha256").update(canonicalJson(snapshot), "utf8").digest();
}
