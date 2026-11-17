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

## drizzle-orm 0.45.4

- Used for: the typed query builder and table metadata in `packages/db`. Migrations are hand-written SQL files; the library
  never creates or alters the schema.
- Licence: Apache-2.0. Published 2026-10-08, more than 14 days before adoption.
- Advisories: a SQL-injection advisory (CVE-2026-39356, 2026-04-06) is fixed in this line; `pnpm audit --audit-level=high`
  reported none at adoption (to be re-read at each upgrade).
- Rejected: Kysely (kept as the fallback: repositories hide the builder); Prisma (its migration and row-level-security model
  does not fit hand-written SQL migrations).

## pg 8.23.1

- Used for: the PostgreSQL client behind the migration runner, the start-up check and the test database harness.
- Licence: MIT. Published 2026-09-30, more than 14 days before adoption. Its native binding (`pg-native`) is an optional
  peer that is not installed.
- Advisories: `pnpm audit --audit-level=high` reported none at adoption (to be re-read at each upgrade).
- Rejected: `postgres` (postgres.js) and `@neondatabase/serverless` (Drizzle's `node-postgres` driver is the one tested with the
  advisory-lock and `set_config` patterns this project needs); a hand-written wire client (infrastructure we do not reinvent).

## @types/pg 8.23.1

- Used for: the type declarations of `pg` under strict TypeScript (a development dependency of `packages/db`).
- Licence: MIT. Published 2026-08-17, more than 14 days before adoption. Types only, no runtime code.
- Advisories: none reported by `pnpm audit --audit-level=high` at adoption.
- Rejected: hand-written declarations (they drift from the library).

## zod 4.6.7

- Used for: parsing the tenant context in `withTenant` at the boundary (`packages/db`); the same library validates every
  other boundary of the project.
- Licence: MIT. Published 2026-10-12 (registry `time` field), more than 14 days before adoption. It has no runtime
  dependencies.
- Advisories: none reported by `pnpm audit --audit-level=high` at adoption (to be re-read at each upgrade).
- Rejected: Valibot (one schema library across the project); hand-written validation (parsers are infrastructure we do not
  reinvent).
