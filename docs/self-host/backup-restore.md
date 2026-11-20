# Backing up and restoring Shoutory

This guide covers the self-host stack of `docker/compose.yml`: PostgreSQL, the app and the media volume. Run every
command from the `docker` folder, with the same environment the stack runs with. A backup is a database dump plus the
secrets that open it; one without the other restores nothing you can use.

## What to keep

Keep these, and keep them **apart from the dump** (a dump next to its keys gives both to whoever finds one place):

- **The whole environment file** you start the stack with: the key-encryption keys (`SHOUTORY_KEK_*`) and the active
  key id, `SHOUTORY_SESSION_SECRET`, `SHOUTORY_HMAC_PEPPER` and every database password
  (`SHOUTORY_DATABASE_PASSWORD_*`, `SHOUTORY_POSTGRES_PASSWORD`). Without the session secret a stored second factor
  cannot be read; without the pepper stored digests no longer match; without a key, the sealed values it protects are
  lost for good.
- **The media volume** (`shoutory-data`, mounted at `/data`) when the storage driver is the filesystem. It is not in
  the dump. With S3-compatible storage the bucket is your provider's to back up.
- **The dump**, taken as described next.

## Take a backup

Dump as the database superuser. The application tables force row security, so a dump taken as the owner or any
application role fails with an error (`pg_dump` turns `row_security` off and stops when a policy would hide a row;
see the `pg_dump` documentation, read 2026-11-20). Only the superuser dumps every row.

```
docker compose exec -T postgres pg_dump -U postgres -d shoutory -Fc -f /tmp/shoutory.dump
docker compose cp postgres:/tmp/shoutory.dump ./shoutory.dump
docker compose exec -T postgres rm /tmp/shoutory.dump
```

Write the file with `-f` and copy it out, as above; piping the dump through a shell redirect can corrupt a binary
file on some systems. The last command removes the copy inside the container, which would otherwise sit in its
writable layer. Store `shoutory.dump` and the media volume where the environment file is not.

Delete your own backups after 35 days; an older one may hold data erased since.

## Restore

1. Have the environment file ready. The database passwords in it are the ones the restored roles will have.
2. Check the dump you copied out before anything is removed. Put the file back under another name and list it; a
   damaged or cut-off file fails here, while the old database is still there:

   ```
   docker compose cp ./shoutory.dump postgres:/tmp/check.dump
   docker compose exec -T postgres pg_restore -l /tmp/check.dump
   docker compose exec -T postgres rm /tmp/check.dump
   ```

3. Stop the app and keep the old database until the restored instance has signed in: copy its volume aside with
   `docker compose stop shoutory postgres`, then `docker volume create <project>_postgres-old` and
   `docker run --rm -v <project>_postgres-data:/from -v <project>_postgres-old:/to --entrypoint cp
   postgres:18.6-alpine -a /from/. /to/`.
4. Remove the old database and its volume: `docker compose rm --stop --force postgres` and
   `docker volume rm <project>_postgres-data`.
5. Start an empty database: `docker compose up --detach --wait postgres`. The first start creates the roles again
   from the environment, with row-security bypass off.
6. Copy the dump in, restore it as the superuser and remove the copy in the container:

   ```
   docker compose cp ./shoutory.dump postgres:/tmp/shoutory.dump
   docker compose exec -T postgres pg_restore -U postgres -d shoutory --exit-on-error /tmp/shoutory.dump
   docker compose exec -T postgres rm /tmp/shoutory.dump
   ```

7. Restore the media volume if you use the filesystem driver; the app must find its files when it starts.
8. Check the secrets (below), then start everything: `docker compose up --detach --wait`.
9. Sign in as an administrator with your password and second-factor code and look at your workspaces and members.
   Once that works, delete the aside copy with `docker volume rm <project>_postgres-old`.

Row security survives a restore: the dump records it with each table, and the restored roles are the same roles.

## Check the secrets

```
docker compose run --rm --no-deps -T shoutory secrets check
```

It exits 0 when every sealed value the database still holds is under a key id your environment has loaded and
active, and 1 and names the ids otherwise. It is a partial check. It reads only the mail links that were sealed and
not yet sent, so on a quiet instance it finds nothing to compare and passes. It compares key ids, not key values: a
wrong key under the same key id passes. Keep each key value exactly as it was, and never reuse a key id for a new
value.

## What a restore cannot do yet

- A restored backup can bring back data that was erased after the backup was taken. The record that replays those
  erasures on a restore is not built yet; until it is, repeat any erasure you were asked to make after restoring.
- Only the database and the files you keep are restored. Nothing here replays the write-ahead log, so a restore
  returns to the moment of the dump, not to the moment of the failure.

## Test your backups

The repository has a drill that does all of the above on a throwaway stack: it signs up the first administrator,
takes the dump, deletes the database volume, restores, and signs in again with a second-factor code. Run it with

```
SHOUTORY_E2E_RESTORE=true pnpm e2e --project restore
```

It runs weekly on Sundays in the repository's `nightly` workflow (job `restore-drill`) and on request. Before every
release tag, start that workflow by hand on the release branch whose tip is the release commit and wait for it to
pass.
