import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cloneTemplate, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();
const DOC = new URL("../../../../docs/compliance/data-categories.md", import.meta.url);

const CATEGORY = /^- `([a-z-]+)`:/gm;
const ROW = /^\| `([a-z_]+\.[a-z_]+)` \| `([a-z-]+)` \|$/gm;

// Every way the page can disagree with the database, as readable lines.
function problems(doc: string, tables: string[]) {
  const categories = new Set([...doc.matchAll(CATEGORY)].map((match) => match[1]));
  const rows = [...doc.matchAll(ROW)].map((match) => ({ table: match[1] ?? "", category: match[2] ?? "" }));
  const listed = rows.map((row) => row.table);
  return [
    ...tables.filter((table) => !listed.includes(table)).map((table) => `no row: ${table}`),
    ...listed.filter((table) => !tables.includes(table)).map((table) => `no such table: ${table}`),
    ...listed.filter((table, at) => listed.indexOf(table) !== at).map((table) => `repeated: ${table}`),
    ...rows.filter((row) => !categories.has(row.category)).map((row) => `unknown category: ${row.category}`),
  ];
}

describe("the data categories page", () => {
  let db: TestDatabase;
  let tables: string[];
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    const found = await db.pool("owner").query<{ name: string }>(
      `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('app', 'auth') AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
    );
    tables = found.rows.map((row) => row.name);
  });
  afterAll(() => db.drop());

  it("every app and auth table has exactly one category row", () => {
    expect(problems(readFileSync(DOC, "utf8"), tables)).toEqual([]);
  });

  it.each([
    [
      "a table with no row",
      (doc: string) => doc.replace("| `app.posts` | `content` |\n", ""),
      "no row: app.posts",
    ],
    [
      "a row with no table",
      (doc: string) => `${doc}| \`app.gone\` | \`none\` |\n`,
      "no such table: app.gone",
    ],
    ["a repeated row", (doc: string) => `${doc}| \`app.posts\` | \`content\` |\n`, "repeated: app.posts"],
    [
      "an unknown category",
      (doc: string) => doc.replace("| `app.posts` | `content` |", "| `app.posts` | `posts` |"),
      "unknown category: posts",
    ],
  ])("finds %s", (_name, plant, expected) => {
    expect(problems(plant(readFileSync(DOC, "utf8")), tables)).toEqual([expected]);
  });
});
