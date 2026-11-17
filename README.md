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
