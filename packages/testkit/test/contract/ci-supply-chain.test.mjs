import { strict as assert } from "node:assert";
import { test } from "node:test";
import allowlist from "../../licence-allowlist.json" with { type: "json" };
import {
  cardProblems,
  exclusionProblems,
  licenceProblems,
  lockfileChangeProblems,
  lockProblems,
  resolutionProblems,
} from "../../scripts/supply-chain.mjs";

const pkg = [{ name: "some-package" }];
const licence = (expression) => licenceProblems({ [expression]: pkg }, allowlist.allowed);
const named = (expression, ...names) =>
  licenceProblems(
    { [expression]: names.map((name) => ({ name })) },
    allowlist.allowed,
    allowlist.allowedPackages,
  );
const exclusion = (entry) => exclusionProblems(`minimumReleaseAgeExclude:${entry}\n`, "2026-11-17");
const TWO_DOCUMENTS = [
  "lockfileVersion: '9.0'",
  "---",
  "packages:",
  "  a@1.0.0:",
  "    resolution: { tarball: 'https://example.test/a.tgz' }",
  "",
].join("\n");
const changed = (...files) => lockfileChangeProblems(files);
const withLock = (file) => changed("pnpm-lock.yaml", file);
const resolution = (value) => resolutionProblems({ packages: { "a@1.0.0": { resolution: value } } });
const card = (cards) => cardProblems([{ file: "apps/api/package.json", dependencies: { hono: "1" } }], cards);

const FORMS = {
  "flow form": (item) => `minimumReleaseAgeExclude: [\n  ${item}\n]\n`,
  "unindented entries": (item) => `minimumReleaseAgeExclude:\n- ${item}\n`,
  "a comment line in the list": (item) => `minimumReleaseAgeExclude:\n  # a note\n  - ${item}\n`,
  "a blank line in the list": (item) =>
    `minimumReleaseAgeExclude:\n  - b@1.0.0 # until 2026-12-01\n\n  - ${item}\n`,
  "CRLF line ends": (item) => `minimumReleaseAgeExclude:\r\n  - ${item}\r\n`,
};
const SHAPES = Object.entries(FORMS).flatMap(([form, write]) => {
  const judge = (item) => () => exclusionProblems(write(item), "2026-11-17");
  return [
    [`${form}: an undated exclusion fails`, judge("a@1.0.0"), 1],
    [`${form}: an expired exclusion fails`, judge("a@1.0.0 # until 2026-01-01"), 1],
    [`${form}: a current exclusion passes`, judge("a@1.0.0 # until 2026-12-01"), 0],
  ];
});

const CASES = [
  ...SHAPES,
  ["a GPL package fails", () => licence("GPL-3.0"), 1],
  ["an allowed licence passes", () => licence("MIT"), 0],
  ["a permissive licence of a transitive tool passes", () => licence("Python-2.0"), 0],
  ["an OR expression with one allowed operand passes", () => licence("(MIT OR GPL-3.0)"), 0],
  ["an AND expression with one refused operand fails", () => licence("MIT AND GPL-3.0"), 1],
  ["an unknown licence fails", () => licence("Unknown"), 1],
  ["an exception clause fails closed", () => licence("MIT WITH GPL-3.0"), 1],
  ["a trailing token fails", () => licence("MIT GPL-3.0"), 1],
  ["a missing closing parenthesis fails", () => licence("(MIT"), 1],
  ["an empty expression fails", () => licence(""), 1],
  [
    "sharp's libvips package, named in the allowlist, passes",
    () => named("LGPL-3.0-or-later", "@img/sharp-libvips-linux-x64"),
    0,
  ],
  [
    "sharp's Windows platform package, named in the allowlist, passes",
    () => named("Apache-2.0 AND LGPL-3.0-or-later", "@img/sharp-win32-x64"),
    0,
  ],
  ["an LGPL package that is not named fails", () => named("LGPL-3.0-or-later", "some-lgpl-package"), 1],
  [
    "a named package under a GPL licence fails",
    () => named("GPL-3.0-only", "@img/sharp-libvips-linux-x64"),
    1,
  ],
  [
    "a named package whose licence adds a GPL clause fails",
    () => named("Apache-2.0 AND GPL-3.0-only", "@img/sharp-win32-x64"),
    1,
  ],
  [
    "only the unnamed package of one licence group fails",
    () => named("LGPL-3.0-or-later", "@img/sharp-libvips-linux-x64", "some-lgpl-package"),
    1,
  ],
  [
    "a package that merely starts like a named one fails",
    () => named("LGPL-3.0-or-later", "@img-evil/sharp-libvips-linux-x64"),
    1,
  ],
  ["an expired exclusion fails", () => exclusion("\n  - a@1.0.0 # until 2026-01-01, advisory"), 1],
  ["an undated exclusion fails", () => exclusion("\n  - a@1.0.0"), 1],
  ["an exclusion that has not expired passes", () => exclusion("\n  - a@1.0.0 # until 2026-12-01"), 0],
  ["an empty exclusion list passes", () => exclusion(" []"), 0],
  ["a lockfile-only change fails", () => changed("pnpm-lock.yaml", "README.md"), 1],
  ["a lockfile change with a manifest passes", () => changed("pnpm-lock.yaml", "apps/api/package.json"), 0],
  ["a manifest outside the workspace does not justify it", () => withLock("docs/x/package.json"), 1],
  ["a provider manifest justifies it", () => withLock("packages/providers/a/package.json"), 0],
  ["a change without the lockfile passes", () => changed("README.md"), 0],
  ["a tarball resolution fails", () => resolution({ tarball: "https://example.test/a.tgz" }), 1],
  ["a git resolution fails", () => resolution({ type: "git", repo: "https://example.test/a.git" }), 1],
  ["a tarball in the second lockfile document fails", () => lockProblems(TWO_DOCUMENTS), 1],
  ["an integrity-only resolution passes", () => resolution({ integrity: "sha512-abc" }), 0],
  ["a runtime dependency without a card fails", () => card("# Dependencies\n"), 1],
  ["a runtime dependency with a card passes", () => card("## hono 1.0.0\n"), 0],
  [
    "a workspace dependency needs no card",
    () =>
      cardProblems([{ file: "apps/api/package.json", dependencies: { "@shoutory/db": "workspace:*" } }], ""),
    0,
  ],
];

for (const [title, check, expected] of CASES) {
  test(`supply chain: ${title}`, () => {
    assert.equal(check().length, expected);
  });
}
