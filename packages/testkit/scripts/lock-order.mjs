// The lock-order check: a function body must take its row locks in the order of the rank table below and never a lower
// rank after a higher one, so two definers can never wait for each other. It reads the SQL of the migrations, takes every
// function body, and lists in text order the statements that lock or write a ranked table: a locking SELECT (FOR UPDATE,
// FOR NO KEY UPDATE, FOR SHARE, FOR KEY SHARE), an UPDATE, a DELETE and an INSERT with ON CONFLICT. A plain SELECT is no
// event, and neither is a plain INSERT: a new row cannot be locked by anyone before it commits. A call to another
// function of the scanned files takes that function's events at the place of the call. A table already locked or written
// earlier in the same function may be touched again (it is the row already held). Tables outside the table are
// ignored. Not modelled: the order of rows within one rank, and the key-share lock a foreign-key check takes on a parent.

// Table to rank. 1.5 is the organization and workspace rows, 7.5 the media rows. The counters of rank 9 keep the order
// in which the table lists them, so each has its own fraction.
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

// The bodies of the functions in the files, by name; a later definition replaces an earlier one.
export function functionBodies(files) {
  const bodies = new Map();
  for (const file of files) {
    for (const [, name, , body] of file.matchAll(FUNCTION)) bodies.set(name.toLowerCase(), body);
  }
  return bodies;
}

const withoutText = (body) => body.replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");

// The table events of one body in text order, as [position, table]; a call is [position, name, "call"].
function events(body, names) {
  const text = withoutText(body);
  const found = [];
  for (const pattern of WRITES) {
    for (const match of text.matchAll(pattern)) found.push([match.index, match[1].toLowerCase()]);
  }
  let from = 0;
  for (const statement of text.split(";")) {
    // An insert that can meet an existing row (ON CONFLICT) waits on it and may update it, so it is an event.
    const insert = /\bINSERT\s+INTO\s+(?:\w+\.)?(\w+)/i.exec(statement);
    if (insert && /\bON\s+CONFLICT\b/i.test(statement))
      found.push([from + insert.index, insert[1].toLowerCase()]);
    const lock = LOCKING.exec(statement);
    if (lock) {
      for (const match of statement.matchAll(/\b(?:FROM|JOIN)\s+(?:\w+\.)?(\w+)/gi)) {
        found.push([from + lock.index, match[1].toLowerCase()]);
      }
    }
    from += statement.length + 1;
  }
  for (const match of text.matchAll(/\b(?:\w+\.)?(\w+)\s*\(/g)) {
    if (names.has(match[1].toLowerCase())) found.push([match.index, match[1].toLowerCase(), "call"]);
  }
  return found.sort((a, b) => a[0] - b[0]);
}

// The ranked tables a function touches, in order, with the calls it makes taken in at their place.
function touches(name, bodies, seen = [], depth = 0) {
  if (depth > CALL_DEPTH || seen.includes(name)) return [];
  return events(bodies.get(name), bodies).flatMap(([, target, call]) =>
    call ? touches(target, bodies, [...seen, name], depth + 1) : RANKS.has(target) ? [target] : [],
  );
}

// A message for each place where a table is touched below a rank already reached and not held already.
export function lockOrderViolations(files) {
  const bodies = functionBodies(files);
  const found = [];
  for (const name of bodies.keys()) {
    const held = new Set();
    let top = "";
    for (const table of touches(name, bodies)) {
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
