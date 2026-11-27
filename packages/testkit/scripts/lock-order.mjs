// A plain SELECT and a plain INSERT are no lock event: a new row cannot be locked by anyone before it commits. Not
// modelled: the order of rows within one rank, and the key-share lock a foreign-key check takes on a parent.

// The counters of rank 9 keep the order in which this list has them, so each has its own fraction.
const COUNTERS = [
  "rate_buckets",
  "provider_quota_ledger",
  "usage_reservations",
  "ai_calls",
  "ai_workspace_counters",
  "agent_budget_counters",
  "agent_chat_tool_counters",
];
export const RANKS = new Map([
  ...["organizations", "workspaces"].map((table) => [table, 1.5]),
  // The claim of a bot is taken before anything else of a connect, and a challenge after the credentials it ends with.
  ["bot_claims", 1.7],
  ["approval_requests", 2],
  ...["post_variants", "reply_targets", "moderation_targets", "posts"].map((table) => [table, 3]),
  ["approval_grants", 4],
  ["channels", 5],
  ["operations", 6],
  ...["operation_attempts", "operation_media", "operation_evidence", "operation_resolutions"].map((table) => [
    table,
    7,
  ]),
  ...["media_assets", "media_derivatives", "media_uploads"].map((table) => [table, 7.5]),
  ["channel_credentials", 8],
  ["connect_challenges", 8.5],
  ...COUNTERS.map((table, at) => [table, 9 + at / 10]),
  ...["idempotency_keys", "outbox", "webhook_deliveries", "webhook_endpoint_sequences"].map((table) => [
    table,
    10,
  ]),
  ["audit_heads", 11],
]);

// The one function that may write a rank-10 row after the audit head (rank 11): its single-row update of its own request
// key, which no other transaction can hold. No other name is ever added.
export const ALLOWED = ["idem_finish"];

const CALL_DEPTH = 4;
const FUNCTION =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:\w+\.)?(\w+)\s*\([\s\S]*?\bAS\s+(\$\w*\$)([\s\S]*?)\2/gi;
const LOCKING = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i;
const WRITES = [
  /\bUPDATE\s+(?:ONLY\s+)?(?:\w+\.)?(\w+)\s+(?:(?:AS\s+)?\w+\s+)?SET\b/g,
  /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:\w+\.)?(\w+)/g,
];

// A later definition of a function replaces an earlier one.
export function functionBodies(files) {
  const bodies = new Map();
  for (const file of files) {
    for (const [, name, , body] of file.matchAll(FUNCTION)) bodies.set(name.toLowerCase(), body);
  }
  return bodies;
}

// Both keep the length of the text, so a position in one is a position in the other.
const withoutComments = (body) => body.replace(/--[^\n]*/g, (found) => " ".repeat(found.length));
const withoutText = (body) =>
  withoutComments(body).replace(/'(?:[^']|'')*'/g, (found) => `''${" ".repeat(found.length - 2)}`);

// `literals` null means the trigger has no WHEN and fires on every change. A trigger's writes happen inside the statement
// that fires it.
const TRIGGER =
  /CREATE\s+TRIGGER\s+\w+\s+AFTER\s[\s\S]*?\sON\s+(?:\w+\.)?(\w+)\s+(?:FOR\s+EACH\s+ROW\s*)?(?:WHEN\s*\(([\s\S]*?)\)\s*)?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:\w+\.)?(\w+)\s*\(/gi;
export function triggersOf(files) {
  const found = new Map();
  for (const file of files) {
    for (const [, table, when, fn] of withoutComments(file).matchAll(TRIGGER)) {
      const literals = when === undefined ? null : [...when.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      found.set(table.toLowerCase(), [
        ...(found.get(table.toLowerCase()) ?? []),
        { fn: fn.toLowerCase(), literals },
      ]);
    }
  }
  return found;
}

// Whether an UPDATE of a table with triggers can fire one: it assigns `state` (a column of that name, not a suffix of
// another) and either assigns something that is not a literal, or a literal the WHEN of a trigger names (any literal when
// a trigger has no WHEN). An update that never assigns a state fires none of the triggers that watch the state.
function firesTrigger(setClause, triggers) {
  const assigned = /\bstate\s*=\s*([\s\S]*?)(?:,\s*[a-z_]+\s*=|$)/i.exec(setClause);
  if (!assigned) return false;
  const literals = [...assigned[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  return (
    literals.length === 0 ||
    triggers.some(
      (trigger) => trigger.literals === null || literals.some((l) => trigger.literals.includes(l)),
    )
  );
}

function triggerCalls(text, raw, match, triggerMap) {
  const triggers = triggerMap.get(match[1].toLowerCase());
  if (!triggers) return [];
  const from = match.index + match[0].length;
  const to = text.slice(from).search(/\bWHERE\b|\bFROM\b|\bRETURNING\b|;|$/i);
  if (!firesTrigger(raw.slice(from, from + to), triggers)) return [];
  return triggers.map(({ fn }) => [match.index, fn, "call"]);
}

function writes(text, raw, triggerMap) {
  const found = [];
  for (const pattern of WRITES) {
    for (const match of text.matchAll(pattern)) {
      found.push([match.index, match[1].toLowerCase()]);
      if (pattern === WRITES[0]) found.push(...triggerCalls(text, raw, match, triggerMap));
    }
  }
  return found;
}

// `FOR UPDATE OF a, b` locks only the rows of those aliases; without OF every table the statement reads is locked.
const LOCKED_OF = new RegExp(`${LOCKING.source}\\s+OF\\s+(\\w+(?:\\s*,\\s*\\w+)*)`, "i");
function lockedTables(statement) {
  const of = LOCKED_OF.exec(statement);
  const only = of ? new Set(of[1].split(",").map((alias) => alias.trim().toLowerCase())) : null;
  return [...statement.matchAll(/\b(?:FROM|JOIN)\s+(?:\w+\.)?(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)]
    .filter((match) => !only || only.has(match[1].toLowerCase()) || only.has(match[2]?.toLowerCase()))
    .map((match) => match[1].toLowerCase());
}

function events(body, names, triggerMap) {
  const text = withoutText(body);
  const found = writes(text, withoutComments(body), triggerMap);
  let from = 0;
  for (const statement of text.split(";")) {
    // An insert that can meet an existing row (ON CONFLICT) waits on it and may update it, so it is an event.
    const insert = /\bINSERT\s+INTO\s+(?:\w+\.)?(\w+)/i.exec(statement);
    if (insert && /\bON\s+CONFLICT\b/i.test(statement))
      found.push([from + insert.index, insert[1].toLowerCase()]);
    const lock = LOCKING.exec(statement);
    if (lock) for (const table of lockedTables(statement)) found.push([from + lock.index, table]);
    from += statement.length + 1;
  }
  for (const match of text.matchAll(/\b(?:\w+\.)?(\w+)\s*\(/g)) {
    if (names.has(match[1].toLowerCase())) found.push([match.index, match[1].toLowerCase(), "call"]);
  }
  return found.sort((a, b) => a[0] - b[0]);
}

function touches(name, bodies, triggers, seen = [], depth = 0) {
  if (depth > CALL_DEPTH || seen.includes(name)) return [];
  return events(bodies.get(name), bodies, triggers).flatMap(([, target, call]) =>
    call ? touches(target, bodies, triggers, [...seen, name], depth + 1) : RANKS.has(target) ? [target] : [],
  );
}

export function lockOrderViolations(files) {
  const bodies = functionBodies(files);
  const triggers = triggersOf(files);
  const found = [];
  for (const name of bodies.keys()) {
    const held = new Set();
    let top = "";
    for (const table of touches(name, bodies, triggers)) {
      const rank = RANKS.get(table);
      const late = top && rank < RANKS.get(top) && !held.has(table);
      const exempt = ALLOWED.includes(name) && rank === 10 && RANKS.get(top) === 11;
      if (late && !exempt)
        found.push(`${name}: ${table} (rank ${rank}) after ${top} (rank ${RANKS.get(top)})`);
      held.add(table);
      if (!top || rank > RANKS.get(top)) top = table;
    }
  }
  return found;
}
