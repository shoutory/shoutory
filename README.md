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

These development database values are for the container and the tests only; the API refuses them at start-up.

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

### Local S3 simulator

The S3 driver's tests run against the Versity S3 gateway, a small Apache-2.0 server. Start it with the keys the tests carry
(throwaway values) and a temporary folder for its data, then export its address:

```sh
MSYS_NO_PATHCONV=1 docker run -d --name shoutory-s3 -p 127.0.0.1:7070:7070 --tmpfs /data \
  versity/versitygw:v1.10.0@sha256:89cad13cc981986ee284cbafea4613f9533ce6fd5f37a2c96c4c4fb8adb3a316 \
  --access shoutory-s3-access-1 --secret shoutory-s3-secret-1 posix /data

export SHOUTORY_TEST_S3_URL=http://127.0.0.1:7070
```

An unsigned request to it is answered 403, which is how to tell it is up. A test run without `SHOUTORY_TEST_S3_URL` fails; it
never skips. `pnpm verify` does not start containers. Remove it with `docker rm -f shoutory-s3`.

`docker/compose.yml` starts the same PostgreSQL bound to `127.0.0.1` only. It takes every credential from the
environment and refuses to start when one is unset, so export the five `SHOUTORY_DATABASE_PASSWORD_*` values above and a
superuser password first, then run `docker compose -f docker/compose.yml up -d`:

```sh
export SHOUTORY_POSTGRES_PASSWORD=postgres-dev-password
```

## Self-hosting

The same file also runs Shoutory: `docker compose -f docker/compose.yml up -d` starts PostgreSQL, applies the migrations
once (`migrate`), then starts the app on `127.0.0.1:3000`. It reads the image from `SHOUTORY_IMAGE` (default
`ghcr.io/shoutory/shoutory:stable`) and refuses to start until every variable in [Configuration](#configuration) it names
is set. To build the image yourself instead of pulling it, run
`docker build -f docker/Dockerfile --build-arg SHOUTORY_RELEASE_CHANNEL=stable -t shoutory .` and set `SHOUTORY_IMAGE=shoutory`.
Behind a reverse proxy, set `SHOUTORY_TRUSTED_PROXIES` to the proxy's address as the container sees it (a CIDR range, for
example the compose network's); while it is empty no `X-Forwarded-For` is believed and every request appears to come from
the proxy. The optional settings (`SHOUTORY_MAIL_MARKETING_FROM`, `SHOUTORY_MAIL_DKIM_SELECTOR`, `SHOUTORY_STORAGE_DRIVER`
and the `SHOUTORY_S3_*` ones) reach the app when they are set where you run compose. The listen port and address are fixed
by the published `127.0.0.1:3000` port, so `SHOUTORY_PORT` and `SHOUTORY_HOST` are not passed.
The container runs as a non-root user with a read-only filesystem, keeps uploads in the `/data` volume, and `pnpm verify
--only image-smoke` (needs Docker) checks the built image end to end.

The image carries `ffprobe` (LGPL-2.1-or-later, no GPL or nonfree options) at `/usr/local/bin/ffprobe`, to read the size,
duration and codec of uploaded videos. It is built from the unmodified FFmpeg 9.0.2 source in the `ffprobe` stage of
[`docker/Dockerfile`](docker/Dockerfile), which holds the tarball URL, its sha256 and the configure line; the build
reads local files only and has no network protocol. The image sets `SHOUTORY_FFPROBE_PATH` to it, so an uploaded mp4,
QuickTime or webm video is probed (15 seconds at most) and becomes ready without being converted or copied;
[`docs/dependencies.md`](docs/dependencies.md) records the signature check and the build packages.

### Backup and restore

What to keep, how to dump and restore, and how to test your backups: [docs/self-host/backup-restore.md](docs/self-host/backup-restore.md).

### Release channels

Release images are published to `ghcr.io/shoutory/shoutory` for `linux/amd64` and `linux/arm64`. A stable release `1.2.3` is
tagged `1.2.3`, `1.2`, `1` (the major tag is left out while the major is 0) and `stable`; a beta release `1.3.0-beta.2`
is tagged `1.3.0-beta.2` and `beta` and never moves `stable`; the build of `main` is tagged `nightly` and
`nightly-YYYYMMDD`. Each release image also has a `-debug` variant under the exact tag plus `-debug` (for example
`1.2.3-debug`, and `beta-debug` for the beta channel), which adds a shell for support. Release images are signed with
cosign and carry an SBOM and a build provenance attestation; check one with
`cosign verify --certificate-identity https://github.com/shoutory/shoutory/.github/workflows/release.yml@refs/tags/v1.2.3
--certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/shoutory/shoutory@<digest>`. The nightly
image is not signed and is built for `linux/amd64` only.

## Configuration

The process refuses to start when a secret is missing, empty, shorter than its floor, all zero, or equal to an example
value shown in this file. No secret has a default, and the error names the variable, never its value. The process also
requires `TZ=UTC`.

| Variable                                                                    | Holds                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SHOUTORY_ACTIVE_KEY_ID`                                                    | The id of the key that seals new secrets: 1-32 characters from `a-z`, `0-9` and `-`                                                                                                                                                                    |
| `SHOUTORY_KEK_<ID>`                                                         | A key-encryption key: base64 of exactly 32 random bytes; the id in uppercase with `-` as `_`                                                                                                                                                           |
| `SHOUTORY_HMAC_PEPPER`                                                      | The pepper for API-key and token digests: at least 32 bytes                                                                                                                                                                                            |
| `SHOUTORY_SESSION_SECRET`                                                   | The session and two-factor secret: at least 32 bytes                                                                                                                                                                                                   |
| `SHOUTORY_SMTP_URL`                                                         | The mail server, `smtp://` (STARTTLS required; add `?requireTLS=false` for a loopback relay with no TLS) or `smtps://`, with its credentials                                                                                                           |
| `SHOUTORY_MAIL_FROM`                                                        | The sender of transactional mail (`user@domain` or `Name <user@domain>`); required for the `worker` and `all` roles                                                                                                                                    |
| `SHOUTORY_MAIL_MARKETING_FROM`                                              | The sender of marketing mail; optional, and it must differ from `SHOUTORY_MAIL_FROM`: marketing mail is refused without it                                                                                                                             |
| `SHOUTORY_MAIL_DKIM_SELECTOR`                                               | The DKIM selector `shoutory mail check` looks up; optional                                                                                                                                                                                             |
| `SHOUTORY_RELEASE_CHANNEL`                                                  | The release channel of this build, `stable` (default), `beta` or `nightly`; the image sets it, and the admin screen shows it                                                                                                                           |
| `SHOUTORY_DATABASE_URL_OWNER`, `_APP`, `_WORKER`, `_AUTH`                   | One connection URL per database role; a process reads only its own: `api` app and auth, `worker` worker, `all` app, auth and worker. The owner URL is read by `migrate` and `audit verify` only (run the latter with `-e SHOUTORY_DATABASE_URL_OWNER`) |
| `SHOUTORY_DATABASE_PASSWORD_OWNER`, `_APP`, `_WORKER`, `_AUTH`, `_READONLY` | The password each database role is created with; only the PostgreSQL container reads them, the app does not                                                                                                                                            |
| `SHOUTORY_PUBLIC_ORIGIN`                                                    | The exact origin the web app is served from (`https://host[:port]`, no path, query or userinfo); no default; a worker may omit it                                                                                                                      |
| `SHOUTORY_WEB_ROOT`                                                         | The absolute folder of the built web app; unset serves no web. Its `index.html` must hold exactly one inline script                                                                                                                                    |
| `SHOUTORY_PORT`                                                             | The port the API listens on, 1-65535; default 3000                                                                                                                                                                                                     |
| `SHOUTORY_TRUSTED_PROXIES`                                                  | Comma-separated CIDR ranges of the reverse proxies whose `X-Forwarded-For` is believed; empty (the default) trusts none                                                                                                                                |
| `SHOUTORY_EGRESS_ALLOW_CIDRS` | Comma-separated CIDR ranges of private addresses that user-supplied URLs may reach (self-host only); metadata and link-local ranges are always refused and a listed one stops the start; empty (the default) allows none |
| `SHOUTORY_HOST`                                                             | The IPv4 or IPv6 address to listen on; unset (the default) listens on all interfaces                                                                                                                                                                   |
| `SHOUTORY_ROLE`                                                             | `api` (HTTP only), `worker` (background jobs, no HTTP) or `all` (both, default)                                                                                                                                                                        |
| `SHOUTORY_STORAGE_DRIVER`                                                   | `fs` (the filesystem, default) or `s3` (an S3-compatible server; its settings below are then all required)                                                                                                                                             |
| `SHOUTORY_DATA_DIR`                                                         | The absolute folder the `fs` driver stores objects in; default `/data`; it must exist and be writable (`shoutory storage check`)                                                                                                                       |
| `SHOUTORY_S3_ENDPOINT`                                                      | With driver `s3`: the S3-compatible endpoint, `http` or `https`, no userinfo, no metadata or link-local address                                                                                                                                        |
| `SHOUTORY_S3_PUBLIC_ENDPOINT`                                               | With driver `s3`: the address browsers upload to through presigned URLs, with the same rules as the endpoint; default the endpoint itself. Set it when the server reaches the bucket at an internal address                                           |
| `SHOUTORY_MEDIA_SCAN`                                                       | `off` (default) or `warn`: with `warn` each uploaded image or video is scanned by your own ClamAV (`clamd`) and a finding or a failed scan is logged; the upload goes on either way |
| `SHOUTORY_CLAMAV_HOST`, `SHOUTORY_CLAMAV_PORT`                              | With `warn`: the `clamd` TCP address (host required; port default 3310, 1-65535). `clamd` has no authentication, so keep it on a private network                         |
| `SHOUTORY_FFPROBE_PATH`                                                     | The absolute path of the `ffprobe` that reads uploaded videos; the image sets it to `/usr/local/bin/ffprobe`. Unset (the default outside the image) or empty turns video off, so an empty value turns it off over the image's setting: a video upload is rejected as an unsupported type. A path that is not an executable file stops the worker at start |
| `SHOUTORY_S3_REGION`, `SHOUTORY_S3_BUCKET`                                  | With driver `s3`: the region and the bucket, which must already exist (the server never creates one)                                                                                                                                                   |
| `SHOUTORY_S3_ACCESS_KEY_ID`, `SHOUTORY_S3_SECRET_ACCESS_KEY`                | With driver `s3`: the access key pair; secrets, never logged and never part of an answer                                                                                                                                                               |
| `SHOUTORY_S3_FORCE_PATH_STYLE`                                              | With driver `s3`: `true` for servers that need path-style addressing; default `false`                                                                                                                                                                  |

With driver `fs` (the default), a browser has no bucket to upload to: register answers the API's own route,
`PUT /api/v1/workspaces/{workspace_id}/media/{media_id}/original`, which takes the raw bytes as
`application/octet-stream` with their `Content-Length` (at most 64 MiB, no chunked bodies) within 15 minutes of
registering. A reverse proxy in front of the app must pass such a body through unbuffered and allow it that size.
The sha256 and size declared at register are not checked at the PUT: complete records those of the stored bytes. A PUT of
other bytes to an upload that already holds some is refused, so a wrong file needs a new register. A slow upload is cut
by the server's request timeout (300 seconds by default).

With driver `s3`, browsers upload straight to the bucket through a presigned URL, so the bucket's CORS rule must allow
the app's origin to `PUT` with the request headers `If-None-Match` and `x-amz-checksum-sha256` (and `Content-Length`,
which browsers send themselves). Without them the browser's preflight is refused and the upload never starts.

With driver `s3`, a file above 64 MiB (up to 5 GiB) goes to the bucket in parts of 16 MiB and never through the app. Register
answers `{ id, part_size }` instead of an upload URL; the browser then asks `POST /api/v1/workspaces/{workspace_id}/media/{media_id}/parts`
with `{ "parts": [{ "number": 1, "sha256": "<hex of that part>" }] }` (at most 20 parts a call, numbered from 1) and gets a
URL for each, valid for 15 minutes, that accepts exactly that part's length and sha256. Asking again for a part re-signs it,
so an upload can be resumed. Complete lists the parts the bucket holds (never a list from the browser), refuses a total that
is not the declared size, and refuses to replace an existing original (the bucket must support `If-None-Match` on completing an
upload). A file above 5 GiB, or above 64 MiB with driver `fs`, which has no part route yet, is refused with 422. The bucket
checks each part's sha256, not the whole file, so the digest declared at register is proved by the worker, which hashes the
original: bytes that differ end the upload as `corrupt`. Until then another member's upload of the same bytes is answered as
a duplicate of it, and registers again if it is rejected. S3 keeps the parts of an upload that is never completed until it is
aborted, so give the bucket a lifecycle rule that aborts incomplete multipart uploads after 7 days
(`AbortIncompleteMultipartUpload`, `DaysAfterInitiation` 7); the app aborts the uploads it refuses itself.

A completed upload is checked, stripped of its metadata and resized by the `worker` role (so also by `all`), which
therefore needs the same storage settings as the `api`: with driver `fs`, the same `SHOUTORY_DATA_DIR` (mount the one
volume in both containers), and with driver `s3`, the same endpoint, bucket and keys. A worker whose storage cannot be
opened does not start. An image the worker cannot process in three tries is rejected as `processing_failed`. A post takes only
ready media that fits its channel's limits: a medium still processing, rejected or over a limit is refused when the
draft is saved (422 `media_unavailable`, with the refused limit in `details.rule`). A scheduled post whose media
are not all ready when it falls due stays scheduled and is taken once they are; if they are still not ready when
the workspace's late window ends, the target is recorded as missed.

Generate real values with `openssl rand -base64 32`. The values below are examples only and are refused at start-up. To
rotate, add a new `SHOUTORY_KEK_<ID>`, point `SHOUTORY_ACTIVE_KEY_ID` at it and keep the old key until no row uses it.

```sh
export SHOUTORY_ACTIVE_KEY_ID=example
export SHOUTORY_KEK_EXAMPLE=c2hvdXRvcnktZXhhbXBsZS1rZWstMDEyMzQ1Njc4OSE=
export SHOUTORY_HMAC_PEPPER=example-pepper-do-not-use-in-production-0001
export SHOUTORY_SESSION_SECRET=example-session-secret-do-not-use-in-production-0001
```

### Running the API

`pnpm build` compiles every package, then `node apps/api/dist/main.js` starts the server for the configured role. It checks the
time zone, the configuration and the applied migrations before it listens, and answers `/healthz` and `/readyz`.

`shoutory migrate` applies the migrations and installs the job queue's schema as the owner role; run it again after a
job queue upgrade. A `worker` or `all` process then runs the scheduled upkeep, a 30-second heartbeat and the outbox relay
as the worker role. `/readyz` is not ready while the outbox or the job queue is behind (60 s and 120 s), while no worker
has beaten within 90 s, or before the job queue is installed; these limits are defaults to confirm.

`pnpm build` also builds the web application (`apps/web`) into `apps/web/dist/client`; `pnpm --filter @shoutory/web exec vite`
serves it for development.

### Identity checks

Sensitive actions (changing the password or the second factor, member changes, instance settings) ask for a fresh identity
check, valid for ten minutes: the password, or a code of the authenticator app for an account with two-step verification on.
A password check made later replaces the code check as the newest one, so such an account is asked for a code again. A
recovery code signs in but records no identity check, so a person without the authenticator app signs in with a recovery
code and cannot manage the second factor until they have a code of the app again.

### Mail

A `worker` or `all` process sends the queued mail over `SHOUTORY_SMTP_URL` from `SHOUTORY_MAIL_FROM`. Marketing mail is a
separate class on its own sender and carries one-click unsubscribe headers; no marketing mail exists yet. `shoutory mail
check` reads the sending domain of `SHOUTORY_MAIL_FROM` and prints whether its SPF, DMARC and DKIM records are present; a
missing record is advice and the command still exits 0.

### Storage

Uploaded media and exports go to the folder `SHOUTORY_DATA_DIR`, which the operator creates and mounts; the server never
creates it, so a missing mount fails instead of filling the container's own disk. `shoutory storage check` writes a small
object, reads it back, deletes it and prints one JSON line: `driver`, `writable`, `readable`, `free_bytes` (null when
unknown) and `failure` (null, or `write_failed`, `read_failed`, `delete_failed` or `timeout`). It exits 0 only when
`failure` is null. The answer never names a path.

### Logs and telemetry

Logs are JSON lines on standard output. Secrets, tokens, cookies and credentials in URLs are removed before a line is
written. OpenTelemetry tracing is off. It starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set to an `http` or `https`
collector address; query strings and userinfo are removed from URL attributes before a span is exported.

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
