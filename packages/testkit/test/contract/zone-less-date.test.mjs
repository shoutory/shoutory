import { strict as assert } from "node:assert";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// Code takes the clock as an input and zone math goes through the Temporal helper, so a Date
// built from zone-less text, a parse of local text, a local getter or a locale string with no zone is refused in the
// folders that hold content, time and ledger rules.
const FOLDERS = ["content", "time", "ledger"];
// Each rule is read over the whole file text, so a call split over several lines is still seen; the optional third
// member decides from the match whether it is a violation (a call is allowed when its arguments name a time zone).
const NAMES_A_ZONE = (match) => !/timeZone/.test(match[1]);
const RULES = [
  [
    "new Date of zone-less text",
    /new Date\(\s*(["'`])((?:(?!\1)[\s\S])*)\1/g,
    (match) => !/(Z|[+-]\d\d:?\d\d)$/.test(match[2]),
  ],
  ["new Date of local parts", /new Date\(\s*[^,()"'`\s][^,()]*,/g],
  ["Date.parse", /\bDate\.parse\(/g],
  ["toLocale string without a zone", /\.toLocale(?:Date|Time)?String\(([^)]*)\)/g, NAMES_A_ZONE],
  ["Intl.DateTimeFormat without a zone", /Intl\.DateTimeFormat\(([^)]*)\)/g, NAMES_A_ZONE],
  ["a local getter", /\.get(?:FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)\(/g],
  ["a local setter", /\.set(?:FullYear|Month|Date|Hours|Minutes|Seconds|Milliseconds)\(/g],
  ["the host zone offset", /\.getTimezoneOffset\(/g],
];

/** The `line: rule` of every violation in one file's text. */
function violations(text) {
  return RULES.flatMap(([rule, pattern, broken = () => true]) =>
    [...text.matchAll(pattern)]
      .filter(broken)
      .map((match) => `${text.slice(0, match.index).split("\n").length}: ${rule}`),
  );
}

/** Every `file:line: rule` the non-test sources under `base/<folder>` break; a missing folder holds nothing. */
function findings(base) {
  return FOLDERS.flatMap((folder) =>
    globSync(`${folder}/**/*.ts`, { cwd: base })
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) =>
        violations(readFileSync(join(base, file), "utf8")).map((found) => `${file}:${found}`),
      ),
  );
}

// Built at run time so that this file holds no zone-less construction itself.
const date = (...parts) => ["new", " Date(", ...parts, ")"].join("");
const quote = (text) => ['"', text, '"'].join("");
const PLANTED = [
  ["zone-less text", `const d = ${date(quote("2027-03-14T02:30"))};`, true],
  ["a Z suffix", `const d = ${date(quote("2027-03-14T02:30:00Z"))};`, false],
  ["an offset suffix", `const d = ${date(quote("2027-03-14T02:30:00+05:30"))};`, false],
  ["a number", `const d = ${date("0")};`, false],
  ["Date.parse", `const n = ${["Date", ".parse(x)"].join("")};`, true],
  ["a locale string", `const s = d.${["toLocale", "String"].join("")}("en");`, true],
  [
    "a locale string with a zone",
    `const s = d.${["toLocale", "String"].join("")}("en", { timeZone: "UTC" });`,
    false,
  ],
  ["a local getter", `const h = d.${["get", "Hours"].join("")}();`, true],
  ["a local setter", `d.${["set", "Hours"].join("")}(1);`, true],
  ["the zone offset of the host", `const o = d.${["getTimezone", "Offset"].join("")}();`, true],
  ["a date from local parts", `const d = ${date("2027, 2, 14, 2, 30")};`, true],
  ["a date from UTC parts", `const d = ${date("Date.UTC(2027, 2, 14)")};`, false],
  ["a formatter with no zone", `const f = ${["new Intl.", 'DateTimeFormat("en")'].join("")};`, true],
  [
    "a formatter with a zone",
    `const f = ${["new Intl.", 'DateTimeFormat("en", { timeZone: "UTC" })'].join("")};`,
    false,
  ],
  // The construction is split over several lines, as a formatter writes a long call.
  ["zone-less text on its own line", `const d = ${date(`\n  ${quote("2027-03-14T02:30")},\n`)};`, true],
  [
    "a locale string whose arguments span lines",
    `const s = d.${["toLocale", "String"].join("")}(\n  "en",\n  { hour: "numeric" },\n);`,
    true,
  ],
];

test("the scanner flags each zone-less pattern in a planted fixture and lets the zoned forms through", () => {
  const base = mkdtempSync(join(tmpdir(), "zone-less-"));
  try {
    mkdirSync(join(base, "time"), { recursive: true });
    writeFileSync(join(base, "time/planted.ts"), PLANTED.map(([, source]) => source).join("\n"));
    const flagged = new Set(findings(base).map((found) => Number(found.split(":")[1])));
    let start = 1;
    for (const [what, source, bad] of PLANTED) {
      assert.equal(flagged.has(start), bad, `${what}: ${bad ? "must be flagged" : "must pass"}`);
      start += source.split("\n").length;
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("no zone-less Date in content, time and ledger code", () => {
  assert.deepEqual(findings(join(root, "packages/core/src")), []);
});
