import { ROLE_PERMISSIONS } from "@shoutory/core/authz";
import { describe, expect, it } from "vitest";
import { type ActionFacts, type ResolutionFacts, resolutionsOf, targetActions } from "./actions.js";

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
    "a published target after both windows",
    published({
      publishedAt: new Date(NOW.getTime() - 7_200_000),
      provider: {
        capabilities: ["text", "edit", "delete"],
        editWindowSeconds: 3600,
        deleteWindowSeconds: 3600,
      },
    }),
    ["duplicate"],
  ],
  [
    "a published target after the edit window and inside the delete window",
    published({
      publishedAt: new Date(NOW.getTime() - 7_200_000),
      provider: {
        capabilities: ["text", "edit", "delete"],
        editWindowSeconds: 3600,
        deleteWindowSeconds: 86_400,
      },
    }),
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

const op = (state: string, over: Partial<ResolutionFacts> = {}): ResolutionFacts => ({
  state,
  kind: "publish",
  reason_code: null,
  effect: "possible",
  ...over,
});
const STEPPED = (kind: string) => ({ kind, step_up: true });
const PLAIN = (kind: string) => ({ kind, step_up: false });

// [case, the operation, whether the person may act on it, what the server lists]
const RESOLUTIONS: [string, ResolutionFacts, boolean, { kind: string; step_up: boolean }[]][] = [
  [
    "an unclear publish",
    op("needs_human"),
    true,
    [STEPPED("attest_published"), STEPPED("attest_not_executed"), STEPPED("supersede"), PLAIN("dismiss")],
  ],
  ["an unclear publish to someone who may not act", op("needs_human"), false, []],
  [
    "a past-due operation after a reconnect",
    op("needs_human", { reason_code: "past_due_after_reconnect", effect: "none" }),
    true,
    [PLAIN("publish_late"), PLAIN("reschedule"), PLAIN("drop")],
  ],
  [
    "a past-due operation that may have sent",
    op("needs_human", { reason_code: "past_due_after_reconnect", effect: "possible" }),
    true,
    [],
  ],
  [
    "a missed operation",
    op("missed", { effect: "none" }),
    true,
    [PLAIN("publish_late"), PLAIN("reschedule")],
  ],
  [
    "an unclear delete",
    op("needs_human", { kind: "delete" }),
    true,
    [STEPPED("confirm_removed"), PLAIN("dismiss")],
  ],
  ["an unverified publish", op("unverified"), true, [STEPPED("attest_published"), STEPPED("supersede")]],
  ["an unverified delete", op("unverified", { kind: "delete" }), true, []],
  ["a pending operation", op("pending", { effect: "none" }), true, []],
];

describe("resolutionsOf", () => {
  it.each(RESOLUTIONS)("%s", (_name, facts, mayAct, expected) => {
    expect(resolutionsOf(facts, mayAct)).toEqual(expected);
  });
});
