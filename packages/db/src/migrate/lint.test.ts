import { describe, expect, it } from "vitest";
import { type LintRule, lintMigration } from "./lint.js";

const ADD =
  "ALTER TABLE posts ADD CONSTRAINT posts_ws_fk FOREIGN KEY (workspace_id) REFERENCES workspaces (id)";

const cases: [string, string, LintRule[]][] = [
  ["a foreign key added validated", `${ADD};`, ["add-constraint-without-not-valid"]],
  ["a foreign key added NOT VALID", `${ADD} NOT VALID;`, []],
  [
    "a check constraint spread over lines in lower case",
    "alter table posts\n  add constraint posts_len\n  check (length(body) > 0);",
    ["add-constraint-without-not-valid"],
  ],
  [
    "a mixed-case unique constraint",
    "AlTeR tAbLe posts AdD cOnStRaInT posts_key UNIQUE (workspace_id, id);",
    ["add-constraint-without-not-valid"],
  ],
  [
    "a unique constraint built from an existing index",
    "ALTER TABLE posts ADD CONSTRAINT posts_key UNIQUE USING INDEX posts_key_idx;",
    [],
  ],
  [
    "an index without CONCURRENTLY",
    "CREATE INDEX posts_ws_idx ON posts (workspace_id);",
    ["create-index-without-concurrently"],
  ],
  [
    "a unique index without CONCURRENTLY",
    "create unique index posts_ws_idx on posts (workspace_id, id);",
    ["create-index-without-concurrently"],
  ],
  ["an index built CONCURRENTLY", "CREATE INDEX CONCURRENTLY posts_ws_idx ON posts (workspace_id);", []],
  ["SET NOT NULL", "ALTER TABLE posts ALTER COLUMN body SET NOT NULL;", ["set-not-null"]],
  [
    "a validation in the file that adds the constraint",
    `${ADD} NOT VALID;\nALTER TABLE posts VALIDATE CONSTRAINT posts_ws_fk;`,
    ["validate-with-add"],
  ],
  [
    "a validation of a constraint another file added",
    "ALTER TABLE posts VALIDATE CONSTRAINT posts_ws_fk;",
    [],
  ],
  [
    "forbidden words inside a literal, a comment and a function body",
    "INSERT INTO notes VALUES ('CREATE INDEX x ON y (z)');\n-- ALTER TABLE a ADD CONSTRAINT b CHECK (c)\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN CREATE INDEX i ON t (c); END $$;",
    [],
  ],
  [
    "an unsafe statement inside a DO block",
    "DO $$ BEGIN CREATE INDEX i ON t (c); END $$;",
    ["create-index-without-concurrently"],
  ],
  [
    "an unsafe statement inside a tagged DO block",
    "DO LANGUAGE plpgsql $body$ BEGIN ALTER TABLE t ALTER COLUMN c SET NOT NULL; END $body$;",
    ["set-not-null"],
  ],
  ["a safe statement inside a DO block", "DO $$ BEGIN CREATE TABLE IF NOT EXISTS t (id int); END $$;", []],
  [
    "two constraints in one statement, the second validated at once",
    "ALTER TABLE posts ADD CONSTRAINT a CHECK (x > 0) NOT VALID, ADD CONSTRAINT b CHECK (y > 0);",
    ["add-constraint-without-not-valid"],
  ],
  [
    "two constraints in one statement, both NOT VALID, with commas inside parentheses",
    "ALTER TABLE posts ADD CONSTRAINT a CHECK (x IN (1, 2)) NOT VALID, ADD CONSTRAINT b CHECK (y > 0) NOT VALID;",
    [],
  ],
  ["a plain new column", "ALTER TABLE posts ADD COLUMN note text;", []],
  [
    "a new column with a constant, now() and current_timestamp default",
    "ALTER TABLE posts ADD COLUMN a int DEFAULT 0, ADD COLUMN b timestamptz DEFAULT now(), ADD COLUMN c timestamptz DEFAULT current_timestamp, ADD COLUMN d text DEFAULT 'x'::text;",
    [],
  ],
  [
    "a new column that references another table",
    "ALTER TABLE posts ADD COLUMN owner_id uuid REFERENCES owners (id);",
    ["add-column-with-constraint"],
  ],
  ["a new unique column", "ALTER TABLE posts ADD COLUMN slug text UNIQUE;", ["add-column-with-constraint"]],
  [
    "a new primary key column",
    "ALTER TABLE posts ADD COLUMN id uuid PRIMARY KEY;",
    ["add-column-with-constraint"],
  ],
  [
    "a new column with a check, the COLUMN word left out",
    "ALTER TABLE posts ADD len int CHECK (len > 0);",
    ["add-column-with-constraint"],
  ],
  [
    "a new column with a random uuid default",
    "ALTER TABLE posts ADD COLUMN id uuid DEFAULT gen_random_uuid();",
    ["add-column-volatile-default"],
  ],
  [
    "a new column with a clock_timestamp default",
    "ALTER TABLE posts ADD COLUMN at timestamptz NOT NULL DEFAULT clock_timestamp();",
    ["add-column-volatile-default"],
  ],
  ["a column type change", "ALTER TABLE posts ALTER COLUMN body TYPE text;", ["alter-column-type"]],
  [
    "a column type change spelled SET DATA TYPE",
    "ALTER TABLE posts ALTER COLUMN body SET DATA TYPE bigint USING body::bigint;",
    ["alter-column-type"],
  ],
  ["DROP INDEX without CONCURRENTLY", "DROP INDEX posts_ws_idx;", ["drop-index-without-concurrently"]],
  ["DROP INDEX CONCURRENTLY", "DROP INDEX CONCURRENTLY IF EXISTS posts_ws_idx;", []],
  ["REINDEX without CONCURRENTLY", "REINDEX INDEX posts_ws_idx;", ["reindex-without-concurrently"]],
  ["REINDEX CONCURRENTLY", "REINDEX INDEX CONCURRENTLY posts_ws_idx;", []],
  [
    "a validation of a quoted constraint name added in the same file",
    'ALTER TABLE posts ADD CONSTRAINT "posts_ws_fk" FOREIGN KEY (workspace_id) REFERENCES workspaces (id) NOT VALID;\nALTER TABLE posts VALIDATE CONSTRAINT "posts_ws_fk";',
    ["validate-with-add"],
  ],
  [
    "a marked no-transaction file with one statement",
    "-- shoutory:no-transaction\nCREATE INDEX CONCURRENTLY posts_ws_idx ON posts (workspace_id);",
    [],
  ],
  [
    "a marked no-transaction file with a comment, a trailing semicolon and blank lines",
    "-- shoutory:no-transaction\n-- builds the index without blocking writes\nCREATE INDEX CONCURRENTLY posts_ws_idx ON posts (workspace_id);\n\n",
    [],
  ],
  [
    "a quoted constraint validated in a later file",
    'ALTER TABLE posts VALIDATE CONSTRAINT "posts_ws_fk";',
    [],
  ],
  [
    "a marked no-transaction file with two statements",
    "-- shoutory:no-transaction\nCREATE INDEX CONCURRENTLY a_idx ON posts (a);\nCREATE INDEX CONCURRENTLY b_idx ON posts (b);",
    ["no-transaction-needs-one-statement"],
  ],
  [
    "a new table with inline constraints",
    "CREATE TABLE tags (id uuid PRIMARY KEY, post_id uuid REFERENCES posts (id));",
    [],
  ],
  [
    "an accepted lock with a reason",
    "-- shoutory:accepted-lock the table is empty at this point\nCREATE INDEX posts_ws_idx ON posts (workspace_id);",
    [],
  ],
  [
    "an accepted lock without a reason",
    "-- shoutory:accepted-lock\nCREATE INDEX posts_ws_idx ON posts (workspace_id);",
    ["accepted-lock-needs-reason", "create-index-without-concurrently"],
  ],
  [
    "an accepted lock that covers only the next statement",
    "-- shoutory:accepted-lock the table is empty\nCREATE INDEX a_idx ON a (x);\nCREATE INDEX b_idx ON b (x);",
    ["create-index-without-concurrently"],
  ],
];

describe("lock lint", () => {
  it.each(cases)("%s", (_title, sql, expected) => {
    expect(
      lintMigration(sql)
        .map((finding) => finding.rule)
        .sort(),
    ).toEqual([...expected].sort());
  });
});
