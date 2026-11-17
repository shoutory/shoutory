// Refuses statements that hold a long lock on a live table. A marker comment on the line before a statement
// accepts it: `-- shoutory:accepted-lock <reason>`, and the reason may not be empty. Literals, comments and
// function bodies are never inspected, so a keyword inside them does not trip a rule; the body of a DO block
// is the one body that is linted, because it runs at once like top-level SQL.

export const NO_TRANSACTION_MARKER = "-- shoutory:no-transaction";

export type LintRule =
  | "add-constraint-without-not-valid"
  | "add-column-with-constraint"
  | "add-column-volatile-default"
  | "alter-column-type"
  | "create-index-without-concurrently"
  | "drop-index-without-concurrently"
  | "reindex-without-concurrently"
  | "set-not-null"
  | "validate-with-add"
  | "no-transaction-needs-one-statement"
  | "accepted-lock-needs-reason";

export interface LintFinding {
  rule: LintRule;
  statement: string;
}

interface Statement {
  text: string;
  comments: string[];
  /** Bodies of a DO block in this statement, linted like top-level SQL. */
  bodies: string[];
}

const TOKEN = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$(\w*)\$[\s\S]*?\$\1\$|;/g;
const ACCEPTED = /^--\s*shoutory:accepted-lock\b(.*)$/;
const IDENT = String.raw`("(?:[^"]|"")+"|\w+)`;
const ADDED_NAME = new RegExp(`\\bADD CONSTRAINT ${IDENT}`, "gi");
const VALIDATED_NAME = new RegExp(`\\bVALIDATE CONSTRAINT ${IDENT}`, "i");
const DO_HEAD = /^DO( LANGUAGE \w+)?$/i;

// A quoted name keeps its exact spelling, an unquoted one is folded to lower case, as PostgreSQL does.
const nameKey = (raw: string): string =>
  raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase();

// Splits on ";" outside literals and keeps each statement's comments and DO bodies; single-quoted literals and
// dollar-quoted bodies are blanked and spaces collapsed, quoted identifiers stay.
function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let text = "";
  let comments: string[] = [];
  let bodies: string[] = [];
  let from = 0;
  const flush = () => {
    if (text.trim() !== "") statements.push({ text: text.replace(/\s+/g, " ").trim(), comments, bodies });
    text = "";
    comments = [];
    bodies = [];
  };
  for (const match of sql.matchAll(TOKEN)) {
    text += sql.slice(from, match.index);
    from = match.index + match[0].length;
    const [token, tag] = match;
    if (token === ";") flush();
    else if (token.startsWith("--")) comments.push(token.trim());
    else if (token.startsWith("/*")) text += " ";
    else if (token.startsWith('"')) text += token;
    else {
      if (tag !== undefined && DO_HEAD.test(text.replace(/\s+/g, " ").trim())) {
        bodies.push(token.slice(tag.length + 2, token.length - tag.length - 2));
      }
      text += " '' ";
    }
  }
  text += sql.slice(from);
  flush();
  return statements;
}

// The comma-separated actions of an ALTER TABLE, split outside parentheses.
function tableActions(text: string): string[] {
  const head = /\bALTER TABLE (IF EXISTS )?(ONLY )?\S+ /i.exec(text);
  if (!head) return [];
  const actions: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text.slice(head.index + head[0].length)) {
    if (char === "," && depth === 0) {
      actions.push(current.trim());
      current = "";
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    current += char;
  }
  return [...actions, current.trim()];
}

const TABLE_CONSTRAINT = /^ADD (CONSTRAINT|CHECK|FOREIGN KEY|UNIQUE|PRIMARY KEY|EXCLUDE)\b/i;
const COLUMN_CONSTRAINT = /\b(REFERENCES|UNIQUE|PRIMARY KEY|CHECK)\b/i;
const DEFAULT_ENDS = /\b(NOT NULL|NULL|CONSTRAINT|CHECK|REFERENCES|UNIQUE|PRIMARY KEY|GENERATED|COLLATE)\b/i;
const FUNCTION_CALL = /\b[a-z_]\w*\s*\(/i;

// A default that calls anything but now() or current_timestamp is volatile and rewrites the table.
function hasVolatileDefault(column: string): boolean {
  const after = /\bDEFAULT\b(.*)$/i.exec(column)?.[1];
  if (after === undefined) return false;
  const expression = (after.split(DEFAULT_ENDS)[0] ?? "")
    .replace(/\bnow\s*\(\s*\)/gi, " ")
    .replace(/\bcurrent_timestamp\b(\s*\(\s*\d*\s*\))?/gi, " ");
  return FUNCTION_CALL.test(expression);
}

function actionRules(action: string): LintRule[] {
  if (TABLE_CONSTRAINT.test(action)) {
    const safe = /\bNOT VALID\b/i.test(action) || /\bUSING INDEX\b/i.test(action);
    return safe ? [] : ["add-constraint-without-not-valid"];
  }
  if (/^ADD\b/i.test(action)) {
    const rules: LintRule[] = [];
    if (COLUMN_CONSTRAINT.test(action)) rules.push("add-column-with-constraint");
    if (hasVolatileDefault(action)) rules.push("add-column-volatile-default");
    return rules;
  }
  return /^ALTER (COLUMN )?\S+ (SET DATA )?TYPE\b/i.test(action) ? ["alter-column-type"] : [];
}

const RULES: [LintRule, (text: string, added: Set<string>) => boolean][] = [
  [
    "create-index-without-concurrently",
    (text) => /\bCREATE (UNIQUE )?INDEX\b(?! CONCURRENTLY\b)/i.test(text),
  ],
  ["drop-index-without-concurrently", (text) => /\bDROP INDEX\b(?! CONCURRENTLY\b)/i.test(text)],
  ["reindex-without-concurrently", (text) => /\bREINDEX\b(?!.*\bCONCURRENTLY\b)/i.test(text)],
  ["set-not-null", (text) => /\bALTER COLUMN \S+ SET NOT NULL\b/i.test(text)],
  [
    "validate-with-add",
    (text, added) => {
      const name = VALIDATED_NAME.exec(text)?.[1];
      return name !== undefined && added.has(nameKey(name));
    },
  ],
];

function lintStatement(statement: Statement, added: Set<string>): LintFinding[] {
  const reasons = statement.comments.map((comment) => ACCEPTED.exec(comment)?.[1]?.trim());
  const finding = (rule: LintRule): LintFinding => ({ rule, statement: statement.text.slice(0, 80) });
  const findings = reasons.includes("") ? [finding("accepted-lock-needs-reason")] : [];
  if (reasons.some((reason) => reason)) return findings;
  const tripped = new Set<LintRule>([
    ...tableActions(statement.text).flatMap(actionRules),
    ...RULES.filter(([, applies]) => applies(statement.text, added)).map(([rule]) => rule),
  ]);
  return [
    ...findings,
    ...[...tripped].map(finding),
    ...statement.bodies.flatMap((body) => lintStatements(splitStatements(body))),
  ];
}

function lintStatements(statements: Statement[]): LintFinding[] {
  const added = new Set(
    statements.flatMap(({ text }) => [...text.matchAll(ADDED_NAME)].map((match) => nameKey(match[1] ?? ""))),
  );
  return statements.flatMap((statement) => lintStatement(statement, added));
}

export function lintMigration(sql: string): LintFinding[] {
  const statements = splitStatements(sql);
  const marked = sql.split(/\r?\n/, 1)[0]?.trim() === NO_TRANSACTION_MARKER;
  const single: LintFinding[] =
    marked && statements.length !== 1
      ? [{ rule: "no-transaction-needs-one-statement", statement: `${statements.length} statements` }]
      : [];
  return [...single, ...lintStatements(statements)];
}
