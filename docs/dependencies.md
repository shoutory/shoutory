# Dependencies

One evaluation card per runtime dependency, added in the same change that adds the dependency. Development tools are
pinned in `package.json` and need no card.

Each card records: the package and its exact pin, what it is used for, its licence, the date it was published (at least
14 days before adoption), maintainers and known advisories, and the alternatives that were rejected.

## yaml 2.9.1

- Used for: parsing the workflow, ruleset and template files in the contract tests (a testkit development dependency).
- Licence: ISC. Published 2026-09-11, more than 14 days before adoption. It has no runtime dependencies.
- Advisories: none recorded at adoption (to be re-read at each upgrade).
- Rejected: a hand-written parser (parsers are infrastructure we do not reinvent); `js-yaml` (YAML 1.1 defaults turn the `on:` key of a
  workflow into a boolean).
