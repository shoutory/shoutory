# Shoutory

Shoutory is a self-hostable social media scheduling and publishing tool for teams and agencies. It plans, approves,
schedules and publishes posts to several networks, and records every external effect so a post is never published
twice and an unclear outcome is never reported as success.

This repository is the open core, licensed under AGPL-3.0-only.

## Requirements

- Node.js 26.13.0 (see `.nvmrc`)
- pnpm 12.17.0 (the `packageManager` field selects it)

## Getting started

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` is the one check command. It runs the type check, lint, dead-code check, unit, integration and contract
tests, and the repository guard, and prints the files each step ran.

## Local database

The integration tests and `shoutory migrate` need PostgreSQL 18 with the database roles of `docker/postgres/init.sql`. The
official image runs that file on first start and reads each role's password from the environment. Use low-entropy
development values only; never reuse a real password.

```sh
export SHOUTORY_DATABASE_PASSWORD_OWNER=owner-dev-password
export SHOUTORY_DATABASE_PASSWORD_APP=app-dev-password
export SHOUTORY_DATABASE_PASSWORD_WORKER=worker-dev-password
export SHOUTORY_DATABASE_PASSWORD_AUTH=auth-dev-password
export SHOUTORY_DATABASE_PASSWORD_READONLY=readonly-dev-password

docker run -d --name shoutory-pg -p 5432:5432 \
  -e POSTGRES_DB=shoutory -e POSTGRES_PASSWORD=postgres-dev-password \
  -e SHOUTORY_DATABASE_PASSWORD_OWNER -e SHOUTORY_DATABASE_PASSWORD_APP -e SHOUTORY_DATABASE_PASSWORD_WORKER \
  -e SHOUTORY_DATABASE_PASSWORD_AUTH -e SHOUTORY_DATABASE_PASSWORD_READONLY \
  -v "$PWD/docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro" \
  postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5
```

Then point the connection settings at it. Each role has its own URL, and the tests also take an administrator URL that
only they read:

```sh
export SHOUTORY_DATABASE_URL_OWNER=postgres://shoutory_owner:owner-dev-password@localhost:5432/shoutory
export SHOUTORY_DATABASE_URL_APP=postgres://shoutory_app:app-dev-password@localhost:5432/shoutory
export SHOUTORY_DATABASE_URL_WORKER=postgres://shoutory_worker:worker-dev-password@localhost:5432/shoutory
export SHOUTORY_DATABASE_URL_AUTH=postgres://shoutory_auth:auth-dev-password@localhost:5432/shoutory
export SHOUTORY_DATABASE_URL_READONLY=postgres://shoutory_readonly:readonly-dev-password@localhost:5432/shoutory
export SHOUTORY_TEST_ADMIN_URL=postgres://postgres:postgres-dev-password@localhost:5432/shoutory
```

A test run without a reachable database fails; it never skips. Remove the container with `docker rm -f shoutory-pg`.

## Layout

- `apps/api`: the HTTP API and background workers
- `apps/web`: the web application
- `packages/core`: contracts and domain rules, no I/O
- `packages/db`: schema, migrations and database access
- `packages/testkit`: repository-wide contract tests and shared test helpers
- `e2e`: browser tests

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities as described in
[SECURITY.md](SECURITY.md), never in a public issue.

## License

Copyright (C) 2026 Mohamed Shaban. Licensed under the GNU Affero General Public License v3.0; see [LICENSE](LICENSE).
