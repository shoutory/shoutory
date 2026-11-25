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

The worker handles uploaded media one file at a time, apart from its other work, and gives each file up to 30 minutes
while it keeps its claim on it. Within that time it copies the original from storage and writes what it derives back, so a
5 GiB video needs about 17 MiB/s between the worker and storage. With driver `s3` a file above 64 MiB is written in parts
of 16 MiB, so the worker holds at most about 150 MiB of it in memory whatever its size.

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
| `SHOUTORY_SCRATCH_DIR`                                                      | The absolute folder, on disk and not in memory, where the worker copies an upload while it checks it, with any storage driver; default `/data/scratch`. A run needs free space of twice the upload's size plus 256 MiB there, or it waits and retries; copies left by a crash are removed when the worker starts |
| `SHOUTORY_MEDIA_WORKSPACE_MAX_BYTES`                                        | The most bytes one workspace may store, in whole bytes; unset is no cap. It counts stored originals, their resized copies, the sizes of uploads not yet finished and deleted files not yet removed from storage. An upload or import that would pass it answers 422 `storage_full`, and, so the cap holds, an upload longer than the size given at register answers 422 `too_large` |
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

With driver `fs`, a file above 64 MiB (up to 5 GiB) goes through the app in parts of 16 MiB. Register answers
`{ id, part_size }`, `POST .../media/{media_id}/parts` answers the app's own URL for each part, and each part is sent with
`PUT .../media/{media_id}/parts/{number}` as `application/octet-stream` with the length the declared file gives it (a part may
be sent again). Complete checks that every part is there, copies them in order into the original and stores it only when its
sha256 is the declared one; a wrong digest stores nothing and keeps the parts for a retry. The copy reads and writes the whole
file, so complete on a large file takes as long as the disk needs for that; a reverse proxy must allow it that time. The
parts and the copy need disk room: up to the cap of pending uploads times 5 GiB of parts, plus one more copy of the file
being assembled. When the disk reports less free space than the declared file, complete answers 503 before it writes anything,
logs a warning and keeps the parts, so the same complete works once there is room. The
worker role removes part files and temporary leftovers of writes that died once they are older than 7 days (a nightly job
over `SHOUTORY_DATA_DIR`, so the worker must see the same folder as the `api`), and the empty `parts` folder of a finished
upload with them.

With driver `s3`, browsers upload straight to the bucket through a presigned URL, so the bucket's CORS rule must allow
the app's origin to `PUT` with the request headers `If-None-Match` and `x-amz-checksum-sha256` (and `Content-Length`,
which browsers send themselves). Without them the browser's preflight is refused and the upload never starts.

With driver `s3`, a file above 64 MiB (up to 5 GiB) goes to the bucket in parts of 16 MiB and never through the app. Register
answers `{ id, part_size }` instead of an upload URL; the browser then asks `POST /api/v1/workspaces/{workspace_id}/media/{media_id}/parts`
with `{ "parts": [{ "number": 1, "sha256": "<hex of that part>" }] }` (at most 20 parts a call, numbered from 1) and gets a
URL for each, valid for 15 minutes, that accepts exactly that part's length and sha256. Asking again for a part re-signs it,
so an upload can be resumed. Complete lists the parts the bucket holds (never a list from the browser), refuses a total that
is not the declared size, and refuses to replace an existing original (the bucket must support `If-None-Match` on completing an
upload). A file above 5 GiB is refused with 422. The bucket
checks each part's sha256, not the whole file, so the digest declared at register is proved by the worker, which hashes the
original: bytes that differ end the upload as `corrupt`. A file of 64 MiB or less is proved by the `x-amz-checksum-sha256`
the bucket returns on `HeadObject`, so a server that does not return it fails those uploads with `no_checksum`
([HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)); the checksum of a multipart object
may be a composite of its parts, which is why the worker proves those. Until then another member's upload of the same bytes is answered as
a duplicate of it, and registers again if it is rejected. S3 keeps the parts of an upload that is never completed until it is
aborted, so give the bucket a lifecycle rule that aborts incomplete multipart uploads after 7 days
(`AbortIncompleteMultipartUpload`, `DaysAfterInitiation` 7); the app aborts the uploads it refuses itself. Save this as
`rule.json` and apply it (the key needs permission to write the bucket's lifecycle configuration, which the app's own key
does not need):

```json
{
  "Rules": [
    {
      "ID": "shoutory-abort-incomplete-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

```sh
aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://rule.json
```

`shoutory storage check` reads the bucket's rules (it never writes one) and warns when none does this.

A member who may edit the library can also import one image or video by URL: `POST /api/v1/workspaces/{workspace_id}/media/import`
with `{ "url": "https://…", "file_name": "optional" }` answers `201 { id }`. The server fetches the URL itself, through the
same network policy as every outbound request: https on port 443 only, no user name or password in the URL, no private,
loopback, link-local or metadata address (a redirect is checked the same way, at most 3), unless the operator allows a range
with `SHOUTORY_EGRESS_ALLOW_CIDRS`. A file is at most 64 MiB (a larger one goes up as an upload in parts), the whole fetch takes
at most 60 seconds, and an encoded response is refused. The type is the one the bytes have, whatever the host says, and only
an image or a video is kept; the asset is named after the last part of the path (never the query) unless a name is given, and
remembers only the origin of the URL. A refusal answers 422 with one reason. `address_not_allowed` means the
policy refused the URL or a redirect of it before any request was made (a private range is reachable only when the operator
lists it in `SHOUTORY_EGRESS_ALLOW_CIDRS`, and a cloud instance never allows one); `fetch_failed` means the request went out and
failed or the host answered anything but 200, of whatever kind, so the route cannot be used to probe a network; `too_large`
means the file is over 64 MiB; `storage_full` means the workspace would pass `SHOUTORY_MEDIA_WORKSPACE_MAX_BYTES`; and `unsupported_type` means a 200 whose bytes are not an image or a video, or that is encoded.
These are three different answers: refused, failed, and answered but not media. The same
bytes imported twice answer the first asset. An import holds its file in memory while it runs, so a server process runs at
most 2 at once and answers 429 with `Retry-After` beyond that (with several instances the limit is 2 for each of them).

A completed upload is checked, stripped of its metadata and resized by the `worker` role (so also by `all`), which
therefore needs the same storage settings as the `api`: with driver `fs`, the same `SHOUTORY_DATA_DIR` (mount the one
volume in both containers), and with driver `s3`, the same endpoint, bucket and keys. A worker whose storage cannot be
opened does not start. An image the worker cannot process in three tries is rejected as `processing_failed`. A post takes only
ready media that fits its channel's limits: a medium still processing, rejected or over a limit is refused when the
draft is saved (422 `media_unavailable`, with the refused limit in `details.rule`). A scheduled post whose media
are not all ready when it falls due stays scheduled and is taken once they are; if they are still not ready when
the workspace's late window ends, the target is recorded as missed.

Generate real values with `openssl rand -base64 32`. The values below are examples only and are refused at start-up, as is
a pepper, session secret or key that repeats another one's value. With compose, `SHOUTORY_ACTIVE_KEY_ID` and every
`SHOUTORY_KEK_<ID>` go in `docker/keys.env` (one `NAME=value` per line, git-ignored), so any number of keys reaches the app;
the file needs Docker Compose 2.24 or later, and compose refuses to start without it.

To rotate a key:

1. Add the new `SHOUTORY_KEK_<ID>`, point `SHOUTORY_ACTIVE_KEY_ID` at it, keep the old key, and recreate the app
   (`docker compose -f docker/compose.yml up -d`; a plain restart does not read the keys file again).
2. Run `shoutory secrets reseal` as the worker role (with compose:
   `docker compose -f docker/compose.yml run --rm shoutory secrets reseal`). It seals email links, channel tokens and
   instance app secrets again under the active key and prints how many it moved. A channel token whose refresh is running,
   or whose last refresh ended with an unknown outcome, is counted as `busy` and left alone: run the command again after
   that channel refreshed or was reconnected. A row it cannot open is counted by its key id and the command exits 1.
3. Run `shoutory secrets check` the same way. It exits 0 only when every sealed row is under the active key; sign-in flows
   in progress still hold the old key until they expire within minutes.
4. Keep the old key for 35 days more, until the last backup taken before the reseal has aged out, then remove it.

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

The line also holds `warnings`, a list of codes (empty when there is nothing to say, and when the probe failed). With driver
`s3` the command reads the bucket's lifecycle rules, and each warning is also printed as one `warning:` line on stderr; the
exit code and the JSON line are not changed by it. The codes: `no_abort_rule` (no enabled rule aborts incomplete multipart
uploads), `abort_rule_too_long` (the fastest rule that covers the app's keys waits more than 7 days),
`abort_rule_excludes_uploads` (the rules that abort uploads have a tag filter or a prefix that leaves out the keys under
`ws/`) and `abort_rule_unreadable` (the server refused the read or has no lifecycle API, as some S3-compatible servers do:
check the rule by hand). The admin screen's storage test returns the same `warnings`.

The `worker` role (so also `all`) removes the objects of media nobody needs, every night, with either driver. It collects a
pending upload 24 hours after it was registered (an upload in parts included, however far it got), a ready or a rejected asset 30 days after it was created, and a deleted
asset 30 days after its deletion, with the original and every derivative. It never collects an asset that a post names,
that an operation which can still send it names, that is in the library, or that is the avatar of its workspace; a saved
version of a post does not keep its media, so restoring a version whose media was collected is refused as unavailable. An
object whose delete fails is logged by the asset's id (never its key or path) and tried again 30 days after the deletion,
and a run that outlasts its 10 minutes stops and leaves the rest for the next night.

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
