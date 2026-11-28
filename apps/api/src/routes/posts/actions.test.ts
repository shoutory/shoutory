import { ROLE_PERMISSIONS } from "@shoutory/core/authz";
import { describe, expect, it } from "vitest";
import { type ActionFacts, targetActions } from "./actions.js";

const NOW = new Date("2026-11-28T10:00:00Z");
const base = (role: keyof typeof ROLE_PERMISSIONS, over: Partial<ActionFacts> = {}): ActionFacts => ({
  scheduleState: "draft",
  presence: "present",
  publishedAt: null,
  operation: null,
  postAuthorId: "author-1",
  principalId: "someone-else",
  permissions: new Set(ROLE_PERMISSIONS[role]),
  provider: { capabilities: ["text", "edit", "delete"], editWindowSeconds: 3600 },
  now: NOW,
  ...over,
});
const published = (over: Partial<ActionFacts> = {}) =>
  base("editor", { scheduleState: "settled", publishedAt: new Date(NOW.getTime() - 60_000), ...over });

// [case, facts, the actions the server lists]
const CASES: [string, ActionFacts, string[]][] = [
  ["a viewer", base("viewer"), []],
  ["an approver", base("approver", { scheduleState: "scheduled" }), []],
  ["a draft", base("editor"), ["schedule", "publish_now", "duplicate"]],
  [
    "a scheduled target",
    base("editor", { scheduleState: "scheduled" }),
    ["schedule", "publish_now", "unschedule", "duplicate"],
  ],
  [
    "a waiting operation to a non-author editor",
    base("editor", { scheduleState: "in_progress", operation: { state: "pending", effect: "none" } }),
    ["duplicate"],
  ],
  [
    "a waiting operation to its author",
    base("editor", {
      scheduleState: "in_progress",
      principalId: "author-1",
      operation: { state: "pending", effect: "none" },
    }),
    ["cancel", "duplicate"],
  ],
  [
    "a waiting operation to an admin",
    base("admin", { scheduleState: "in_progress", operation: { state: "retry_wait", effect: "none" } }),
    ["cancel", "duplicate"],
  ],
  [
    "an operation that may have sent",
    base("admin", { scheduleState: "in_progress", operation: { state: "pending", effect: "possible" } }),
    ["duplicate"],
  ],
  [
    "an operation that needs a person",
    base("admin", { scheduleState: "in_progress", operation: { state: "needs_human", effect: "possible" } }),
    ["resolve", "duplicate"],
  ],
  ["a published target", published(), ["edit", "delete", "duplicate"]],
  [
    "a published target after the edit window",
    published({ publishedAt: new Date(NOW.getTime() - 7_200_000) }),
    ["delete", "duplicate"],
  ],
  [
    "a published target of a provider that cannot edit",
    published({ provider: { capabilities: ["text", "delete"] } }),
    ["delete", "duplicate"],
  ],
  [
    "a published target with an edit in flight",
    published({ operation: { state: "pending", effect: "none" } }),
    ["duplicate"],
  ],
  ["a published target being removed", published({ presence: "removal_pending" }), ["duplicate"]],
];

describe("targetActions", () => {
  it.each(CASES)("%s", (_name, facts, expected) => {
    expect(targetActions(facts)).toEqual(expected);
  });
});
