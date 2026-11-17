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

## pino 10.4.0

- Used for: the structured JSON logger of `apps/api`. Every line passes one scrubber (`hooks.logMethod` and
  `formatters.bindings`) before Pino writes it; Pino's own `redact` is not used because its paths cover one level per `*`.
- Licence: MIT. Published 2026-10-02, more than 14 days before adoption.
- Advisories: none reported by `pnpm audit --audit-level=high` at adoption (to be re-read at each upgrade).
- Rejected: winston and bunyan (slower, no hook before serialization); `console` (banned in `src` by Biome); a hand-written
  logger (infrastructure we do not reinvent).

Opt-in tracing in `apps/api` uses the seven OpenTelemetry packages below. They start only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is non-empty. Each is Apache-2.0, was published 2026-10-20 (more than 14 days before
adoption), and had no advisory in `pnpm audit --audit-level=high` at adoption (re-read at each upgrade).

## @opentelemetry/api 1.10.0

- Used for: the tracer API types and the global tracer registration the telemetry tests read.
- Rejected: none; every other package here requires it as a peer.

## @opentelemetry/sdk-node 0.300.0

- Used for: starting the SDK with explicit span processors and instrumentations.
- Rejected: its auto-configured exporter (it exports to a default address when no endpoint is set), so the SDK is never
  started without an endpoint; a vendor agent (a second egress path).

## @opentelemetry/sdk-trace 3.0.0

- Used for: the span processor contract and `BatchSpanProcessor`; the processor that strips query strings and userinfo from
  URL attributes wraps it.
- Rejected: `sdk-trace-base`, which is deprecated and whose peer range excludes api 1.10.0.

## @opentelemetry/exporter-trace-otlp-http 0.300.0

- Used for: sending spans to the operator's collector over Node `http`/`https`. `protobufjs`, which it pulls in, has a
  postinstall that only checks a version; it is not allowed to run (`pnpm-workspace.yaml`).
- Rejected: the gRPC and protobuf exporters (more dependencies for the same job).

## @opentelemetry/instrumentation-http 0.300.0

- Used for: spans for incoming and outgoing Node `http` requests.
- Rejected: `auto-instrumentations-node` (a large bundle; instrumentations are listed explicitly).

## @opentelemetry/instrumentation-pg 0.77.0

- Used for: spans for PostgreSQL queries.
- Rejected: `auto-instrumentations-node`, as above.

## @opentelemetry/instrumentation-undici 0.34.0

- Used for: spans for outgoing `fetch` and undici requests.
- Rejected: `auto-instrumentations-node`, as above.

## hono 4.13.16

- Used for: the HTTP framework of `apps/api` (routing, `bodyLimit`, `secureHeaders`, `getConnInfo` through the node adapter).
- Licence: MIT. Published 2026-11-01, more than 14 days before adoption (the first release that fixes five advisories of 4.13.14). It has no
  runtime dependencies and one npm maintainer.
- Advisories: the five high advisories of earlier lines are all in optional middleware (JWT, serveStatic, CORS, ALB adapter),
  which an import rule bans; `pnpm audit --audit-level=high` reported none at adoption.
- Rejected: Fastify (kept as the fallback); Express (no typed validation layer).

## @hono/node-server 2.1.6

- Used for: serving the Hono app on Node (`serve`) and reading the socket peer address (`getConnInfo`).
- Licence: MIT. Published 2026-11-02, more than 14 days before adoption (the first release that fixes two advisories of 2.1.5). It has no
  runtime dependencies.
- Advisories: none reported by `pnpm audit --audit-level=high` at adoption. Its `serve-static` export is not used.
- Rejected: a hand-written `node:http` adapter (infrastructure we do not reinvent).

## @hono/zod-openapi 1.6.3

- Used for: declaring each route with its Zod schemas (`createRoute`, `openapi`) so validation and the OpenAPI document
  come from one definition. Its transitive `@hono/zod-validator` is never imported directly.
- Licence: MIT. Published 2026-09-04, more than 14 days before adoption. Runtime dependencies: `openapi3-ts`,
  `@asteasolutions/zod-to-openapi`, `@hono/zod-validator`.
- Advisories: none reported by `pnpm audit --audit-level=high` at adoption.
- Rejected: hand-written route validation (parsers are infrastructure we do not reinvent).

## zod (apps/api)

- `apps/api` now declares `zod` 4.6.7 too: its route schemas are `z.strictObject`. The card above holds the evaluation.
