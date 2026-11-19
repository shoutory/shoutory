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

## better-auth 1.7.16

- Used for: email and password sign-up and sign-in, database sessions, email verification, password reset and change,
  and the second factor (the `better-auth/plugins/two-factor` entry: TOTP, backup codes in the `encrypted` mode),
  behind our own route mount in `apps/api/src/auth/`. The email OTP endpoints of that plugin are disabled. Our adapter
  wrapper stores session tokens as digests, and its built-in rate limit and telemetry are off. The breached-password
  plugin is not used: it fails closed, so `apps/api/src/auth/hibp.ts` is ours.
- Licence: MIT. Published 2026-11-03, more than 14 days before adoption. Its runtime dependencies (package.json of the
  pin) are `@better-auth/utils`, `@better-fetch/fetch`, `@noble/ciphers`, `@noble/hashes`, `better-call`, `defu`, `jose`,
  `kysely`, `nanostores` and `zod`, and the `@better-auth/*` packages of the same pin (`core`, `telemetry` and the
  `drizzle`, `kysely`, `memory`, `mongo` and `prisma` adapters). We import `better-auth/minimal`, which does not load Kysely.

## Common-password list (data, packages/core)

- Used for: the "bundled common-password list" of the password policy (`packages/core/src/password/`). It is data, not
  a package: the 10,000 entries of SecLists `Passwords/Common-Credentials/10k-most-common.txt`, read from the
  repository's default branch on 2026-11-18 (73,026 bytes, 10,001 lines, no upper-case or non-ASCII entry), embedded as
  one string in `common-passwords.ts` by a one-off conversion that adds nothing. It drops one entry, a provider
  name, because no core file may carry one (AGENTS 5.1).
- Licence: MIT, "Copyright (c) 2018 Daniel Miessler", verified by reading
  https://raw.githubusercontent.com/danielmiessler/SecLists/master/LICENSE on 2026-11-18. The full notice is in the
  header of `common-passwords.ts`, as the licence requires of every copy. The list is not a runtime dependency and
  downloads nothing.
- Rejected: the NCSC 100k list (the licence of its origin could not be verified) and a run-time download (AGENTS 4.9).
  The breached-password range check covers the breadth the 10,000 entries do not.

## @better-auth/core 1.7.16

- Used for: one import, `queueAfterTransactionHook` from `@better-auth/core/context`, which runs the sign-up mail
  enqueue after the transaction commits. It is already installed as a dependency of `better-auth` at the same release;
  `apps/api` declares it exactly (1.7.16, the register pin) so that import is direct.
- Licence: MIT. Published 2026-11-03 with `better-auth`, more than 14 days before adoption. Advisories: as `better-auth`.
- Rejected: reaching it through `better-auth` re-exports (the entry used is not re-exported) and a hand-written
  after-commit queue (infrastructure we do not reinvent).
- Advisories: 1.7.16 is the register pin that carries the GHSA-9hm7-xhfp-cx58 fix; no later 1.7.x release is an
  advisory fix (checked 2026-11-18). Re-read at each upgrade.
- Rejected: Auth.js (maintenance mode), Lucia (deprecated), a self-written session layer (authentication and sessions are
  infrastructure we do not reinvent).

## pg-boss 12.38.0

- Used for: the job queue's wake-ups and schedules in `apps/api/src/jobs/` (the worker role). The operation ledger, not the
  queue, holds the truth; jobs carry ids only. `shoutory migrate` installs its schema as the owner role, and the worker
  starts it with `migrate: false` as the `shoutory_worker` role.
- Licence: MIT. Published 2026-10-13, more than 14 days before adoption. Its runtime dependencies are `cron-parser`,
  `rrule-temporal`, `serialize-error` (all MIT) and `pg` (already pinned at 8.23.1); `@opentelemetry/api` is a peer
  that `apps/api` already declares.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: a hand-written queue engine (infrastructure we do not reinvent).

## nodemailer 10.3.1

- Used for: the SMTP transport of the mail sender in `apps/api/src/jobs/mail-sender.ts`. SMTP is the only built-in
  transport; the operator brings any SMTP server through `SHOUTORY_SMTP_URL`.
- Licence: MIT-0 (`package.json` of the tarball says `MIT-0`; its `LICENSE` file is the MIT grant without the attribution
  clause). Published 2026-10-29, more than 14 days before adoption. It has no runtime dependencies and ships its own type
  declarations, so no `@types` package is added.
- Egress: the SMTP connection is an operator-configured outbound call that does not go through `egressFetch`; it is an
  operator egress exception that the egress policy lists.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: a hand-written SMTP client and MIME composer (infrastructure we do not reinvent).

## @aws-sdk/client-s3 3.1161.0

- Used for: the optional S3-compatible storage driver in `apps/api/src/storage/s3-driver.ts` (put, get and delete of whole
  objects). The presigner package and multipart upload are not added; the slices that need them add their own cards.
- Licence: Apache-2.0. Published 2026-10-30, more than 14 days before adoption. Its install scripts: none (no package in
  its tree needs a build script, so `strictDepBuilds` stays satisfied).
- Egress: the SDK keeps its own HTTP handler; the operator-chosen endpoint is checked at start-up (http or https, no
  userinfo, no metadata or link-local host) until the egress policy lists S3 as an operator exception.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: `@aws-sdk/lib-storage` (multipart is not needed for the objects this driver writes); a hand-written SigV4 client
  (signing is infrastructure we do not reinvent); the MinIO client (its server is archived).

## react 19.3.1

- Used for: the user interface of `apps/web`.
- Licence: MIT. Published 2026-10-14, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: Preact and Solid (the accessible component library and the editor and calendar libraries chosen for the web app
  are built for React).

## react-dom 19.3.1

- Used for: rendering the React tree into the page (`apps/web/src/main.tsx`). It is pinned to the same version as `react`.
- Licence: MIT. Published 2026-10-14, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: server rendering (the web app is a same-origin static build, no SSR).

## react-router 8.5.1

- Used for: client routing in data mode (`createBrowserRouter`) in `apps/web/src/app.tsx`. Only the library packages are
  used; the framework tooling (`@react-router/dev`) is banned by lint.
- Licence: MIT. Published 2026-10-27, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: TanStack Router (a second routing model beside the pinned data-router loaders and actions); a hand-written
  router (infrastructure we do not reinvent).

## @tailwindcss/vite 4.3.3

- Used for: compiling Tailwind CSS in the Vite build of `apps/web` (a development dependency; the compiled CSS ships).
- Licence: MIT. Published 2026-07-16, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: `@tailwindcss/postcss` (one more config file for no gain); CSS-in-JS runtimes (the logical-utility lint is built
  on Tailwind class names).

## @vitejs/plugin-react 6.1.2

- Used for: the JSX transform and Fast Refresh in the Vite build of `apps/web` (a development dependency).
- Licence: MIT. Published 2026-10-05, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: `@vitejs/plugin-react-swc` (a native compiler binary for no need of ours).

## @types/react 19.3.0

- Used for: the type declarations of `react` under strict TypeScript in `apps/web` (a development dependency). Types only, no
  runtime code.
- Licence: MIT. Published 2026-09-09, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it.
- Rejected: hand-written declarations (they drift from the library).

## @types/react-dom 19.3.0

- Used for: the type declarations of `react-dom` (`createRoot`) in `apps/web` (a development dependency). Types only, no
  runtime code.
- Licence: MIT. Published 2026-09-09, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it.
- Rejected: hand-written declarations (they drift from the library).

## tailwindcss 4.3.3

- Used for: the utility classes and the `@theme` token mechanism of `apps/web` (`src/index.css`); only logical utilities are
  allowed (a contract test refuses the physical ones). A development dependency; the compiled CSS ships.
- Licence: MIT. Published 2026-07-16, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: hand-written utility CSS (the token and logical-utility rules are built on Tailwind's names).

## @fontsource-variable/bricolage-grotesque 5.3.0

- Used for: the Latin display and heading face of `apps/web`, self-hosted as WOFF2 files that Vite bundles and the server
  serves from the same origin (no font CDN). The variable weight axis covers 200 to 800 in one file per script subset.
- Licence: OFL-1.1 (the SIL Open Font License; the package carries the licence text). Published 2026-07-19, more than 14 days
  before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: a font CDN (the web app makes no runtime call to a third-party host for fonts); vendoring the files by hand (the package keeps the licence and
  the subsets in step with each release).

## @fontsource/ibm-plex-sans 5.3.0

- Used for: the Latin body and interface face of `apps/web` (weights 400, 500 and 600, Latin subset only).
- Licence: OFL-1.1 (the SIL Open Font License; the package carries the licence text). Published 2026-07-19, more than 14 days
  before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: a font CDN; Inter (the owner's identity names IBM Plex Sans).

## @fontsource/ibm-plex-sans-arabic 5.3.0

- Used for: the Arabic face of `apps/web` for body, interface and headings (weights 400, 500, 600 and 700, Arabic subset only).
- Licence: OFL-1.1 (the SIL Open Font License; the package carries the licence text). Published 2026-07-19, more than 14 days
  before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: Cairo (retired by the owner's identity decision); a font CDN.

## happy-dom 21.0.4

- Used for: the DOM of the web unit tests (`vitest` environment `happy-dom`); a development dependency, never shipped.
- Licence: MIT. Published 2026-10-20, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: jsdom (heavier, and its extra dependencies add install weight for the same tests).

## @lingui/core 6.11.0

- Used for: the message catalogs and the `i18n` instance of `apps/web` (`src/i18n/i18n.ts`); ICU messages with Arabic's six
  plural forms. Every message carries an explicit dotted id.
- Licence: MIT. Published 2026-10-29, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: react-i18next and FormatJS (Lingui compiles catalogs at build time and has the macro transform the plan names).

## @lingui/react 6.11.0

- Used for: `I18nProvider` and the `Trans` component (through its macro) in `apps/web`. Pinned to the same version as
  `@lingui/core`.
- Licence: MIT. Published 2026-10-29, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: a hand-written provider (infrastructure we do not reinvent).

## @lingui/cli 6.11.0

- Used for: reading `lingui.config.mjs` and compiling the PO catalogs for the Vite plugin (a development dependency, a peer
  of `@lingui/vite-plugin`). Catalog extraction is not run: the PO files are written by hand with explicit ids.
- Licence: MIT. Published 2026-10-29, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: compiled catalogs committed to the repository (nothing generated is committed).

## @lingui/format-po 6.11.0

- Used for: the PO catalog format named in `lingui.config.mjs` (a development dependency). PO is the format translators' tools
  read.
- Licence: MIT. Published 2026-10-29, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: JSON catalogs (fewer translator tools read them).

## @lingui/vite-plugin 6.11.0

- Used for: compiling the PO catalogs when they are imported and transforming the Lingui macros with its native transform, so
  no Babel step is needed (a development dependency).
- Licence: MIT. Published 2026-10-29, more than 14 days before adoption. Its install scripts: none.
- Advisories: `pnpm audit --audit-level=high` reported none after adding it. Re-read at each upgrade.
- Rejected: the Babel and SWC macro routes (extra plugin pins for the same transform).
