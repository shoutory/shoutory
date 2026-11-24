# AGENTS.md

Working rules for anyone, human or tool, who changes this repository. Read `CONTRIBUTING.md` for the process.

## Layout

- `apps/api`: Hono HTTP API and background workers (`SHOUTORY_ROLE=api|worker|all`); admin commands in `apps/api/src/cli/`.
- `apps/web`: the single-page web app.
- `packages/core`: contracts and domain rules. No I/O.
- `packages/db`: Drizzle schema, hand-written SQL migrations, row security and tenant context.
- `packages/testkit`: repository-wide contract tests (`test/contract/`) and invariants (`test/invariants/`).
- `e2e`: Playwright specs in `specs/`, helpers in `support/`, data in `fixtures/`.

Dependencies point one way: `core` is imported by `db` and `api`; `core` imports nothing from the other packages. Cloud-only
code never lands in this repository, and this repository never branches on a cloud flag.

## Commands

- `pnpm verify`: the one check command. Run it before every commit.
- `pnpm test:focus <directory>`: tests of one package by directory name (`core`, `db`, `api`).
- `node --test "packages/testkit/test/contract/*.test.mjs"`: the contract tests.

## Rules

- TypeScript strict; no `any`; parse every input with Zod at the boundary.
- Functions stay under 50 lines; no `console` and no `Math.random` in `src`; never swallow an error with an empty or
  blanket `catch`.
- One concept per file; no barrel files; no abstraction that has a single implementation.
- Every tenant table has row security enabled and forced. Set the tenant only through `withTenant`.
- Comments are few: write one only where the code cannot say why, in plain words, never an internal tracking id.
- Migrations are forward-only SQL in `packages/db/migrations/NNNN_name.sql`; an applied migration is never edited,
  except a comment-only revision listed with its old and new checksums in the migration runner.
- Every outbound request goes through `egressFetch`. Secrets never appear in logs, errors, URLs or test fixtures.
- Time comes in as an input; zone arithmetic goes through the Temporal helper.
- Tailwind logical properties only (no `left` or `right`); user-visible text goes through Lingui.
- Tests: written first, one level per behaviour, table-driven for repeated cases, never skipped or retried.
- Dependencies: exact pins, at least 14 days old, an evaluation card in `docs/dependencies.md`.
- Commits: `type(scope): imperative summary`, one behaviour each.
