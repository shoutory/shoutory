import { strict as assert } from "node:assert";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SKIPPED = new Set(["node_modules", "dist", ".git", ".artifacts", ".turbo"]);
const CODE = ["ts", "tsx", "mts", "js", "cjs", "mjs"];
// The admin list resolves every loaded flag by its own key, so its key is not a literal.
const DYNAMIC_OK = "apps/api/src/routes/admin/";

const inTestFile = (file) =>
  file.split("/").includes("test") || /\.test\.(ts|tsx|mts|js|cjs|mjs)$/.test(file);

function codeFiles(base) {
  const exclude = (name) => SKIPPED.has(name);
  return globSync(`{apps,packages}/**/*.{${CODE.join(",")}}`, { cwd: base, exclude })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !inTestFile(file))
    .sort();
}

// A seed row is ('key', 'description', 'owner', [date] 'YYYY-MM-DD', ...): the column order of the table. A delete
// names the key. Both are read in file order, so a later delete removes an earlier row.
const SEED_EVENT = new RegExp(
  `\\(\\s*'([a-z][a-z0-9_-]*)'\\s*,\\s*'(?:[^']|'')*'\\s*,\\s*'(?:[^']|'')*'\\s*,\\s*(?:date\\s*)?'(\\d{4}-\\d{2}-\\d{2})'` +
    "|DELETE\\s+FROM\\s+app\\.feature_flags\\s+WHERE\\s+key\\s*=\\s*'([^']+)'",
  "gi",
);

function seedOf(base) {
  const dir = join(base, "packages/db/migrations");
  const seed = new Map();
  if (!existsSync(dir)) return seed;
  for (const file of globSync("*.sql", { cwd: dir }).sort()) {
    const sql = readFileSync(join(dir, file), "utf8").replace(/--[^\n]*/g, "");
    for (const [, key, date, deleted] of sql.matchAll(SEED_EVENT)) {
      if (deleted) seed.delete(deleted);
      else seed.set(key, date);
    }
  }
  return seed;
}

// `flags.isOn(ctx, "key")`: the key group is empty when the second argument is not a plain string literal.
const READ_CALL = /\bflags\.isOn\([^,]+,\s*(?:(["'`])([a-z][a-z0-9_-]*)\1\s*\))?/g;

const check = (base, today) => {
  const seed = seedOf(base);
  const expired = [...seed]
    .filter(([, date]) => date < today)
    .map(([key, date]) => `${key} is past its removal date ${date}`);
  const reads = codeFiles(base).flatMap((file) =>
    [...readFileSync(join(base, file), "utf8").matchAll(READ_CALL)].flatMap(([, , key]) => {
      if (key === undefined) {
        return file.startsWith(DYNAMIC_OK) ? [] : [`${file} reads a flag with a key that is not a literal`];
      }
      return seed.has(key) ? [] : [`${key} is read in ${file} and is not in the seed`];
    }),
  );
  return [...expired, ...reads];
};

const today = () => new Date().toISOString().slice(0, 10);

test("every flag key read in code is in the seed and no seed row is past its removal date", () => {
  assert.ok(codeFiles(root).length >= 1, "no code file was scanned");
  assert.deepEqual(check(root, today()), []);
});

function plant(files) {
  const base = mkdtempSync(join(tmpdir(), "flags-catalog-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), content);
  }
  return base;
}

const SEED = (key, date) =>
  `INSERT INTO app.feature_flags (key, description, owner, remove_by, default_on)\n  VALUES ('${key}', 'a flag, with (odd) text', 'owner-1', date '${date}', false);\n`;
const READ = (key) => `import { flags } from "@shoutory/core/flags";\nflags.isOn(ctx, "${key}");\n`;
const TODAY = "2026-11-19";

const FLAGGED = [
  [
    "a key read in code and missing from the seed",
    { "apps/api/src/a.ts": READ("flag-missing-1") },
    ["flag-missing-1 is read in apps/api/src/a.ts and is not in the seed"],
  ],
  [
    "a seed row past its removal date",
    { "packages/db/migrations/0100_x.sql": SEED("flag-old-1", "2026-11-18") },
    ["flag-old-1 is past its removal date 2026-11-18"],
  ],
  [
    "a key whose seed row a later migration deleted",
    {
      "packages/db/migrations/0100_x.sql": SEED("flag-ga-1", "2027-01-01"),
      "packages/db/migrations/0101_y.sql": "DELETE FROM app.feature_flags WHERE key = 'flag-ga-1';\n",
      "apps/api/src/b.ts": READ("flag-ga-1"),
    },
    ["flag-ga-1 is read in apps/api/src/b.ts and is not in the seed"],
  ],
  [
    "a key that is not a literal",
    { "apps/api/src/c.ts": "flags.isOn(ctx, name);\n" },
    ["apps/api/src/c.ts reads a flag with a key that is not a literal"],
  ],
];
for (const [title, files, expected] of FLAGGED) {
  test(`the check flags a planted case: ${title}`, () => {
    const base = plant(files);
    try {
      assert.deepEqual(check(base, TODAY), expected);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

const SPARED = [
  [
    "a key in the seed that is read",
    {
      "packages/db/migrations/0100_x.sql": SEED("flag-ok-1", "2027-01-01"),
      "apps/api/src/d.ts": READ("flag-ok-1"),
    },
  ],
  ["a seed row due today", { "packages/db/migrations/0100_x.sql": SEED("flag-today-1", TODAY) }],
  ["a non-literal key in the admin list", { [`${DYNAMIC_OK}admin.ts`]: "flags.isOn(ctx, flag.key);\n" }],
];
for (const [title, files] of SPARED) {
  test(`the check spares ${title}`, () => {
    const base = plant(files);
    try {
      assert.deepEqual(check(base, TODAY), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
