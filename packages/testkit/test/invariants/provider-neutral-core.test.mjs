import { strict as assert } from "node:assert";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ROOTS = ["apps/api/src", "apps/web/src/messages", "packages/core/src", "packages/db/src"];
const SKIPPED = new Set(["node_modules", "dist", ".git", ".artifacts", ".turbo"]);
const EXTENSIONS = ["ts", "tsx", "mts", "js", "cjs", "mjs", "json", "po", "md"];

// The distinctive names of the planned provider portfolio (PRD 01 and 02). Names that are ordinary words (Meta, X,
// Threads, Medium, Slack) are left out: `import.meta` and plain prose would fire on them, and review catches those.
const NAMES = [
  "Bluesky",
  "Mastodon",
  "Telegram",
  "Discord",
  "LinkedIn",
  "Facebook",
  "Instagram",
  "YouTube",
  "TikTok",
  "Pinterest",
  "WordPress",
  "Tumblr",
  "Reddit",
  "Twitter",
];
// Substring match, so identifiers such as `blueskyClient` and `TELEGRAM_TOKEN` are caught. Two names need care: Google
// Business may be joined by a space, underscore or hyphen, and Dev.to must not match `devtools`.
const PATTERN = new RegExp(
  [...NAMES, "google[ _-]?business", "dev\\.to(?!ols)", "devto(?!ols)"].join("|"),
  "i",
);

function scannedFiles(base) {
  const exclude = (name) => SKIPPED.has(name);
  return ROOTS.flatMap((dir) => globSync(`${dir}/**/*.{${EXTENSIONS.join(",")}}`, { cwd: base, exclude }))
    .map((file) => file.replaceAll("\\", "/"))
    .sort();
}

const offenders = (base) =>
  scannedFiles(base).filter((file) => PATTERN.test(readFileSync(join(base, file), "utf8")));

function plant(files) {
  const base = mkdtempSync(join(tmpdir(), "provider-neutral-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), content);
  }
  return base;
}

test("no provider name appears in the core roots", () => {
  assert.ok(scannedFiles(root).length >= 1, "no file was scanned");
  assert.deepEqual(offenders(root), []);
});

const NAME = NAMES[0];
const FLAGGED = [
  ...EXTENSIONS.map((ext) => [`a .${ext} file`, `packages/core/src/planted.${ext}`, `// ${NAME}\n`]),
  ["upper case", "apps/api/src/up.ts", `const a = "${NAME.toUpperCase()}";\n`],
  ["lower case", "packages/db/src/low.ts", `const a = "${NAME.toLowerCase()}";\n`],
  ["inside a message file", "apps/web/src/messages/en.po", `msgstr "Post to ${NAMES[1]}"\n`],
  ["a test file in a root", "packages/core/src/x.test.ts", `it("${NAMES[2]} fails", () => {});\n`],
  ...[
    ["camel case prefix", "const blueskyClient = 1;"],
    ["camel case suffix", "const isBluesky = true;"],
    ["upper snake", "const TELEGRAM_TOKEN = 1;"],
    ["lower snake", "function post_to_telegram() {}"],
    ["a longer word", `const a = "${NAME}ish";`],
    ["Google Business with a space", "// Google Business Profile"],
    ["Google Business with an underscore", "const GOOGLE_BUSINESS = 1;"],
    ["Google Business joined", "const googlebusiness = 1;"],
    ["Dev.to", 'const a = "https://dev.to/api";'],
    ["devto", "const devtoClient = 1;"],
    ["DEVTO_TOKEN", "const DEVTO_TOKEN = 1;"],
  ].map(([title, content], i) => [`an identifier: ${title}`, `packages/core/src/id${i}.ts`, `${content}\n`]),
];
for (const [title, file, content] of FLAGGED) {
  test(`the scan flags a planted name: ${title}`, () => {
    const base = plant({ [file]: content });
    try {
      assert.deepEqual(offenders(base), [file]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

const SPARED = [
  ["the placeholder", "packages/core/src/a.ts", 'const a = "Post to {name}";\n'],
  [
    "a common word that is also a name",
    "packages/core/src/b.ts",
    "const a = import.meta.url; // Threads, Meta, X\n",
  ],
  ["devtools", "packages/core/src/c.ts", "import { devtools } from './tools';\n"],
  ["a file outside the roots", "packages/testkit/src/d.ts", `// ${NAME}\n`],
  ["an unscanned extension", "packages/core/src/e.txt", `${NAME}\n`],
];
for (const [title, file, content] of SPARED) {
  test(`the scan spares ${title}`, () => {
    const base = plant({ [file]: content });
    try {
      assert.deepEqual(offenders(base), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
