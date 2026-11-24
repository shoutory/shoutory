-- No runtime role holds a grant on either table; every access is a definer with its own purpose policy.

-- The data key of every credential of the workspace is wrapped under a key derived from the key-encryption key and
-- this salt, so deleting the row makes every copy of the credentials unreadable, backups included (crypto-shred).
CREATE TABLE app.workspace_key_salts (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces (id),
  salt bytea NOT NULL CHECK (octet_length(salt) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
SELECT app.apply_rls_template('app.workspace_key_salts'::regclass, 'D');

-- A reconnect or a refresh replaces the sealed fields in place and moves `generation`, which the AAD of the seal
-- binds. The refresh lease only keeps two refreshers from calling the provider at once; the compare-and-set key is
-- the digest of the refresh token in use together with the generation. The attempt marker records that a rotating
-- refresh token may already have been spent.
CREATE TABLE app.channel_credentials (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation >= 1),
  kind text NOT NULL CHECK (kind IN ('channel_token', 'bot_token', 'webhook_url')),
  format_version integer NOT NULL,
  key_id text NOT NULL CHECK (key_id ~ '^[a-z0-9-]{1,32}$'),
  iv bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  wrap_iv bytea NOT NULL,
  wrap_tag bytea NOT NULL,
  wrapped_dek bytea NOT NULL,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  refresh_token_digest text CHECK (char_length(refresh_token_digest) BETWEEN 1 AND 128),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'read_only', 'superseded', 'destroyed')),
  refreshing_until timestamptz,
  refresh_owner text CHECK (char_length(refresh_owner) BETWEEN 1 AND 64),
  refresh_fencing integer NOT NULL DEFAULT 0 CHECK (refresh_fencing >= 0),
  refresh_attempt_digest text CHECK (char_length(refresh_attempt_digest) BETWEEN 1 AND 128),
  refresh_attempt_outcome text CHECK (refresh_attempt_outcome IN ('ok', 'failed', 'unknown')),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES app.channels (workspace_id, id) ON DELETE CASCADE
);
-- shoutory:accepted-lock new empty table in this file
CREATE UNIQUE INDEX channel_credentials_current_key ON app.channel_credentials (workspace_id, channel_id, kind)
  WHERE state IN ('active', 'read_only');
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX channel_credentials_access_expiry_idx ON app.channel_credentials (access_expires_at)
  WHERE state = 'active';
SELECT app.apply_rls_template('app.channel_credentials'::regclass, 'D');

GRANT SELECT, INSERT ON app.workspace_key_salts TO shoutory_definer;
GRANT SELECT, INSERT, UPDATE ON app.channel_credentials TO shoutory_definer;
GRANT INSERT ON app.channels TO shoutory_definer;
GRANT UPDATE (instance_host, display_name, handle, avatar, token_expires_at, health, health_checked_at,
  capability_epoch, disconnected_at) ON app.channels TO shoutory_definer;
GRANT SELECT, INSERT, DELETE ON app.channel_capability_snapshots TO shoutory_definer;

CALL app.grant_purposes('workspace_key_salts', 'SELECT', ARRAY['workspace_salt_ensure', 'credential_open']);
CALL app.grant_purposes('workspace_key_salts', 'INSERT', ARRAY['workspace_salt_ensure']);
CALL app.grant_purposes('channel_credentials', 'SELECT', ARRAY['channel_connect', 'credential_put', 'credential_open',
  'credential_refresh_begin', 'credential_refresh_commit', 'credential_refresh_fail', 'due_token_refreshes',
  'channel_enable', 'sealed_key_ids']);
CALL app.grant_purposes('channel_credentials', 'INSERT', ARRAY['credential_put']);
CALL app.grant_purposes('channel_credentials', 'UPDATE', ARRAY['credential_put', 'credential_refresh_begin',
  'credential_refresh_commit', 'credential_refresh_fail']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['channel_connect', 'credential_put', 'credential_open',
  'credential_refresh_commit',
  'credential_refresh_fail', 'channel_health_record', 'due_token_refreshes']);
CALL app.grant_purposes('channels', 'INSERT', ARRAY['channel_connect']);
CALL app.grant_purposes('channels', 'UPDATE', ARRAY['channel_connect', 'credential_put', 'credential_refresh_commit',
  'credential_refresh_fail', 'channel_health_record']);
CALL app.grant_purposes('channel_capability_snapshots', 'SELECT', ARRAY['channel_health_record']);
CALL app.grant_purposes('channel_capability_snapshots', 'INSERT', ARRAY['channel_health_record']);
CALL app.grant_purposes('channel_capability_snapshots', 'DELETE', ARRAY['channel_health_record']);
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['workspace_salt_ensure', 'channel_connect', 'credential_put',
      'credential_open', 'credential_refresh_begin', 'credential_refresh_commit', 'credential_refresh_fail',
      'channel_health_record']);
  END LOOP;
END
$$;

-- Every function below is created by the definer role, so it is owned by it without a later ALTER OWNER.
SET ROLE shoutory_definer;

-- The one principal check of the credential definers: a user whose rank in the workspace is admin or above, or a job
-- principal whose workspace set holds the workspace. A service or portal principal, an Editor and a job of another
-- workspace all get the same refusal.
CREATE FUNCTION app.credential_caller(workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  kind constant text := app.principal_kind();
  ok boolean;
BEGIN
  IF kind = 'user' THEN
    ok := app.principal_id() IS NOT NULL AND app.tenancy_rank(workspace_id, app.principal_id()) >= 4;
  ELSIF kind = 'job' THEN
    ok := workspace_id = ANY (app.ws_ids());
  END IF;
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'credential: refused' USING ERRCODE = '42501';
  END IF;
END
$$;

-- Two first-credential callers end with one salt: the loser receives the winner's. The application draws the 32
-- random bytes because PostgreSQL has no cryptographic random bytes in core.
CREATE FUNCTION app.workspace_salt_ensure(workspace_id uuid, salt bytea)
RETURNS bytea
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  held bytea;
BEGIN
  PERFORM set_config('app.job_purpose', 'workspace_salt_ensure', true);
  PERFORM app.credential_caller(workspace_salt_ensure.workspace_id);
  IF workspace_salt_ensure.salt IS NULL OR octet_length(workspace_salt_ensure.salt) <> 32 THEN
    RAISE EXCEPTION 'workspace_salt_ensure: the salt must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.workspace_key_salts (workspace_id, salt)
    VALUES (workspace_salt_ensure.workspace_id, workspace_salt_ensure.salt)
    ON CONFLICT ON CONSTRAINT workspace_key_salts_pkey DO NOTHING;
  SELECT s.salt INTO held FROM app.workspace_key_salts AS s WHERE s.workspace_id = workspace_salt_ensure.workspace_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN held;
END
$$;

-- A snapshot is written only when the answer changed from the latest one (the channel epoch moves with it) and the
-- last 5 are kept; a NULL health leaves the health columns alone, so credential_put can use this for the first
-- snapshot. True means a snapshot was written.
CREATE FUNCTION app.channel_health_record(
  workspace_id uuid, channel_id uuid, health text, manifest_digest text, api_version text, sunset_at timestamptz,
  capabilities jsonb, limits jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  latest record;
  next_epoch integer;
  changed boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'channel_health_record', true);
  PERFORM app.credential_caller(channel_health_record.workspace_id);
  PERFORM 1 FROM app.channels AS c
    WHERE c.workspace_id = channel_health_record.workspace_id AND c.id = channel_health_record.channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_health_record: refused' USING ERRCODE = '42501';
  END IF;
  SELECT s.epoch, s.manifest_digest, s.api_version, s.sunset_at, s.capabilities, s.limits INTO latest
    FROM app.channel_capability_snapshots AS s
    WHERE s.workspace_id = channel_health_record.workspace_id AND s.channel_id = channel_health_record.channel_id
    ORDER BY s.epoch DESC LIMIT 1;
  changed := latest.epoch IS NULL OR (latest.manifest_digest, latest.api_version, latest.sunset_at, latest.capabilities,
      latest.limits) IS DISTINCT FROM (channel_health_record.manifest_digest, channel_health_record.api_version,
      channel_health_record.sunset_at, channel_health_record.capabilities, channel_health_record.limits);
  IF changed THEN
    next_epoch := coalesce(latest.epoch, 0) + 1;
    INSERT INTO app.channel_capability_snapshots (workspace_id, channel_id, epoch, manifest_digest, api_version,
        sunset_at, capabilities, limits)
      VALUES (channel_health_record.workspace_id, channel_health_record.channel_id, next_epoch,
        channel_health_record.manifest_digest, channel_health_record.api_version, channel_health_record.sunset_at,
        channel_health_record.capabilities, channel_health_record.limits);
    DELETE FROM app.channel_capability_snapshots AS s
      WHERE s.workspace_id = channel_health_record.workspace_id AND s.channel_id = channel_health_record.channel_id
        AND s.epoch <= next_epoch - 5;
    UPDATE app.channels AS c SET capability_epoch = next_epoch
      WHERE c.workspace_id = channel_health_record.workspace_id AND c.id = channel_health_record.channel_id;
  END IF;
  IF channel_health_record.health IS NOT NULL THEN
    UPDATE app.channels AS c SET health = channel_health_record.health, health_checked_at = clock_timestamp()
      WHERE c.workspace_id = channel_health_record.workspace_id AND c.id = channel_health_record.channel_id;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN changed;
END
$$;

-- The identity key makes a concurrent first connect wait for the first and reuse its row, so no retry exists. The
-- answer carries the generation the next credential must carry, which the application needs before it can seal. A
-- reconnect that names a different identity is refused with the generic SH409, which names nothing.
CREATE FUNCTION app.channel_connect(
  workspace_id uuid, provider_id text, account_kind text, provider_account_id text, instance_host text,
  display_name text, handle text, avatar text, reconnect_channel_id uuid, request_id text, ip_hmac bytea)
RETURNS TABLE (channel_id uuid, next_generation integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  found_id uuid;
  newest integer;
  org uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'channel_connect', true);
  PERFORM app.credential_caller(channel_connect.workspace_id);
  IF channel_connect.reconnect_channel_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.channels AS c
       WHERE c.workspace_id = channel_connect.workspace_id AND c.id = channel_connect.reconnect_channel_id
         AND c.provider_id = channel_connect.provider_id
         AND c.provider_account_id = channel_connect.provider_account_id) THEN
    RAISE EXCEPTION 'channel_connect: this account cannot be connected here' USING ERRCODE = 'SH409';
  END IF;
  INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, instance_host, display_name,
      handle, avatar)
    VALUES (channel_connect.workspace_id, channel_connect.provider_id, channel_connect.account_kind,
      channel_connect.provider_account_id, channel_connect.instance_host, channel_connect.display_name,
      channel_connect.handle, channel_connect.avatar)
    ON CONFLICT ON CONSTRAINT channels_identity_key DO NOTHING;
  SELECT c.id INTO found_id FROM app.channels AS c
    WHERE c.workspace_id = channel_connect.workspace_id AND c.provider_id = channel_connect.provider_id
      AND c.provider_account_id = channel_connect.provider_account_id FOR UPDATE;
  UPDATE app.channels AS c SET instance_host = channel_connect.instance_host, display_name = channel_connect.display_name,
      handle = channel_connect.handle, avatar = channel_connect.avatar
    WHERE c.id = found_id;
  SELECT coalesce(max(k.generation), 0) + 1 INTO newest FROM app.channel_credentials AS k
    WHERE k.workspace_id = channel_connect.workspace_id AND k.channel_id = found_id AND k.kind = 'channel_token'
      AND k.state IN ('active', 'read_only');
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = channel_connect.workspace_id;
  PERFORM app.audit_append(channel_connect.workspace_id, org, coalesce(app.principal_kind(), 'job'),
    coalesce(app.principal_id()::text, 'job'), 'channel.connected', 'channel', found_id::text,
    channel_connect.request_id, channel_connect.ip_hmac,
    jsonb_build_object('provider_id', channel_connect.provider_id));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN QUERY SELECT found_id, newest;
END
$$;

-- expected_generation is the current one (0 for none) and the row moves to the next. A generation that is not the next
-- is refused (SH409): the AAD binds it, so a stale seal must never land. The application ensures the salt before it seals.
CREATE FUNCTION app.credential_put(
  workspace_id uuid, channel_id uuid, expected_generation integer, format_version integer, key_id text, iv bytea,
  ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea, access_expires_at timestamptz,
  refresh_expires_at timestamptz, refresh_token_digest text, manifest_digest text, api_version text,
  sunset_at timestamptz, capabilities jsonb, limits jsonb, request_id text, ip_hmac bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  prior text := current_setting('app.job_purpose', true);
  current_generation integer;
BEGIN
  PERFORM set_config('app.job_purpose', 'credential_put', true);
  PERFORM app.credential_caller(credential_put.workspace_id);
  PERFORM 1 FROM app.channels AS c
    WHERE c.workspace_id = credential_put.workspace_id AND c.id = credential_put.channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credential_put: refused' USING ERRCODE = '42501';
  END IF;
  SELECT k.generation INTO current_generation FROM app.channel_credentials AS k
    WHERE k.workspace_id = credential_put.workspace_id AND k.channel_id = credential_put.channel_id
      AND k.kind = 'channel_token' AND k.state IN ('active', 'read_only') FOR UPDATE;
  IF coalesce(current_generation, 0) <> credential_put.expected_generation THEN
    RAISE EXCEPTION 'credential_put: not the next generation' USING ERRCODE = 'SH409';
  END IF;
  INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv,
      ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, access_expires_at, refresh_expires_at,
      refresh_token_digest)
    VALUES (credential_put.workspace_id, credential_put.channel_id, credential_put.expected_generation + 1,
      'channel_token', credential_put.format_version, credential_put.key_id, credential_put.iv,
      credential_put.ciphertext, credential_put.auth_tag, credential_put.wrap_iv, credential_put.wrap_tag,
      credential_put.wrapped_dek, credential_put.access_expires_at, credential_put.refresh_expires_at,
      credential_put.refresh_token_digest)
    ON CONFLICT (workspace_id, channel_id, kind) WHERE state IN ('active', 'read_only') DO UPDATE SET
      generation = EXCLUDED.generation, state = 'active', format_version = EXCLUDED.format_version,
      key_id = EXCLUDED.key_id, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, auth_tag = EXCLUDED.auth_tag,
      wrap_iv = EXCLUDED.wrap_iv, wrap_tag = EXCLUDED.wrap_tag, wrapped_dek = EXCLUDED.wrapped_dek,
      access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
      refresh_token_digest = EXCLUDED.refresh_token_digest, refreshing_until = NULL, refresh_owner = NULL,
      refresh_attempt_digest = NULL, refresh_attempt_outcome = NULL;
  UPDATE app.channels AS c SET token_expires_at = credential_put.access_expires_at
    WHERE c.workspace_id = credential_put.workspace_id AND c.id = credential_put.channel_id;
  -- An administrator's disable outlives a reconnect: only enable lifts it.
  UPDATE app.channels AS c SET connection_state = 'connected', state_reason = NULL, reconnect_deadline = NULL,
      disconnected_at = NULL
    WHERE c.workspace_id = credential_put.workspace_id AND c.id = credential_put.channel_id
      AND c.connection_state <> 'disabled';
  PERFORM app.channel_health_record(credential_put.workspace_id, credential_put.channel_id, NULL,
    credential_put.manifest_digest, credential_put.api_version, credential_put.sunset_at, credential_put.capabilities,
    credential_put.limits);
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- With no active row or with the salt row deleted (crypto-shred) it answers no row at all, so no sealed field leaves
-- without its salt. It also names the channel's provider, which the worker role cannot read from the channel row.
CREATE FUNCTION app.credential_open(workspace_id uuid, channel_id uuid)
RETURNS TABLE (
  generation integer, format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea,
  wrap_tag bytea, wrapped_dek bytea, access_expires_at timestamptz, refresh_expires_at timestamptz,
  refresh_token_digest text, salt bytea, provider_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'credential_open', true);
  PERFORM app.credential_caller(credential_open.workspace_id);
  RETURN QUERY
    SELECT k.generation, k.format_version, k.key_id, k.iv, k.ciphertext, k.auth_tag, k.wrap_iv, k.wrap_tag,
        k.wrapped_dek, k.access_expires_at, k.refresh_expires_at, k.refresh_token_digest, s.salt, c.provider_id
      FROM app.channel_credentials AS k
      JOIN app.workspace_key_salts AS s ON s.workspace_id = k.workspace_id
      JOIN app.channels AS c ON c.workspace_id = k.workspace_id AND c.id = k.channel_id
      WHERE k.workspace_id = credential_open.workspace_id AND k.channel_id = credential_open.channel_id
        AND k.kind = 'channel_token' AND k.state = 'active';
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Enable restores `connected` only when the channel holds a usable credential: an active channel_token row whose
-- refresh token has not expired. Otherwise it is needs_reconnect with a 30-day window.
CREATE OR REPLACE FUNCTION app.channel_enable(workspace_id uuid, channel_id uuid, request_id text, ip_hmac bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  target record;
  org uuid;
  usable boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'channel_enable', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'channel_enable: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM app.tenancy_enter('channel_enable', channel_enable.workspace_id, caller, 4);
  SELECT c.connection_state, c.provider_id INTO target FROM app.channels AS c
    WHERE c.workspace_id = channel_enable.workspace_id AND c.id = channel_enable.channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_enable: refused' USING ERRCODE = '42501';
  END IF;
  IF target.connection_state <> 'disabled' THEN
    RAISE EXCEPTION 'channel_enable: not_disabled' USING ERRCODE = 'SH409';
  END IF;
  SELECT EXISTS (SELECT 1 FROM app.channel_credentials AS k
      WHERE k.workspace_id = channel_enable.workspace_id AND k.channel_id = channel_enable.channel_id
        AND k.kind = 'channel_token' AND k.state = 'active'
        AND (k.refresh_expires_at IS NULL OR k.refresh_expires_at > clock_timestamp())) INTO usable;
  UPDATE app.channels AS c SET state_reason = NULL,
      connection_state = CASE WHEN usable THEN 'connected' ELSE 'needs_reconnect' END,
      reconnect_deadline = CASE WHEN usable THEN NULL
        ELSE coalesce(c.reconnect_deadline, clock_timestamp() + interval '30 days') END
    WHERE c.workspace_id = channel_enable.workspace_id AND c.id = channel_enable.channel_id;
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = channel_enable.workspace_id;
  PERFORM app.audit_append(channel_enable.workspace_id, org, 'user', caller::text, 'channel.enabled', 'channel',
    channel_enable.channel_id::text, channel_enable.request_id, channel_enable.ip_hmac,
    jsonb_build_object('provider_id', target.provider_id));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- A key-encryption key is retired only when no mail link and no credential still uses it.
CREATE OR REPLACE FUNCTION app.sealed_key_ids()
RETURNS TABLE (key_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'sealed_key_ids', true);
  RETURN QUERY
    SELECT e.link_key_id FROM app.email_outbox AS e WHERE e.link_ciphertext IS NOT NULL
    UNION
    SELECT k.key_id FROM app.channel_credentials AS k WHERE k.state IN ('active', 'read_only');
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Token refresh is three short transactions around a provider call that holds no lock: begin takes the lease and
-- writes the attempt marker (outcome unknown) in its own commit, the application calls the provider, then commit or
-- fail ends it. The channel row is locked before the credential row wherever both change.

-- The answer carries the marker that stood before this attempt, so the caller can tell an earlier attempt that is
-- still unknown. A caller that loses the lease sees won = false with the current row.
CREATE FUNCTION app.credential_refresh_begin(workspace_id uuid, channel_id uuid, lease_owner text, lease_seconds integer)
RETURNS TABLE (
  won boolean, fencing integer, generation integer, refresh_token_digest text, prior_attempt_digest text,
  prior_attempt_outcome text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  cur record;
  fence integer;
  leased boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'credential_refresh_begin', true);
  PERFORM app.credential_caller(credential_refresh_begin.workspace_id);
  IF credential_refresh_begin.lease_seconds IS NULL OR credential_refresh_begin.lease_seconds NOT BETWEEN 5 AND 300
     OR credential_refresh_begin.lease_owner IS NULL
     OR char_length(credential_refresh_begin.lease_owner) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'credential_refresh_begin: the lease must be 5 to 300 seconds and have an owner' USING ERRCODE = '22023';
  END IF;
  SELECT k.generation, k.refresh_token_digest, k.refresh_fencing, k.refreshing_until, k.refresh_attempt_digest,
      k.refresh_attempt_outcome INTO cur
    FROM app.channel_credentials AS k
    WHERE k.workspace_id = credential_refresh_begin.workspace_id AND k.channel_id = credential_refresh_begin.channel_id
      AND k.kind = 'channel_token' AND k.state = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN;
  END IF;
  leased := cur.refreshing_until IS NOT NULL AND cur.refreshing_until > clock_timestamp();
  fence := cur.refresh_fencing;
  IF NOT leased THEN
    UPDATE app.channel_credentials AS k SET refreshing_until = clock_timestamp()
          + make_interval(secs => credential_refresh_begin.lease_seconds),
        refresh_owner = credential_refresh_begin.lease_owner, refresh_fencing = k.refresh_fencing + 1,
        refresh_attempt_digest = k.refresh_token_digest, refresh_attempt_outcome = 'unknown'
      WHERE k.workspace_id = credential_refresh_begin.workspace_id AND k.channel_id = credential_refresh_begin.channel_id
        AND k.kind = 'channel_token' AND k.state = 'active'
      RETURNING k.refresh_fencing INTO fence;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN QUERY SELECT NOT leased, fence, cur.generation, cur.refresh_token_digest, cur.refresh_attempt_digest,
    cur.refresh_attempt_outcome;
END
$$;

-- Lands only while the refresh token digest and the generation (which the AAD of the new seal binds) are unchanged.
-- The lease is not part of the key, so a result from the current token lands even after its lease ran out; a
-- competing late commit fails because its digest or generation moved. The lease and marker are cleared only while
-- refresh_fencing is still the caller's, so a stale refresher never clears a newer lease or its marker.
CREATE FUNCTION app.credential_refresh_commit(
  workspace_id uuid, channel_id uuid, expected_digest text, expected_generation integer, expected_fencing integer,
  format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea,
  access_expires_at timestamptz, refresh_expires_at timestamptz, refresh_token_digest text)
RETURNS TABLE (landed boolean, generation integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  new_generation integer;
  did_land boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'credential_refresh_commit', true);
  PERFORM app.credential_caller(credential_refresh_commit.workspace_id);
  PERFORM 1 FROM app.channels AS c
    WHERE c.workspace_id = credential_refresh_commit.workspace_id AND c.id = credential_refresh_commit.channel_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credential_refresh_commit: refused' USING ERRCODE = '42501';
  END IF;
  UPDATE app.channel_credentials AS k SET generation = k.generation + 1,
      format_version = credential_refresh_commit.format_version, key_id = credential_refresh_commit.key_id,
      iv = credential_refresh_commit.iv, ciphertext = credential_refresh_commit.ciphertext,
      auth_tag = credential_refresh_commit.auth_tag, wrap_iv = credential_refresh_commit.wrap_iv,
      wrap_tag = credential_refresh_commit.wrap_tag, wrapped_dek = credential_refresh_commit.wrapped_dek,
      access_expires_at = credential_refresh_commit.access_expires_at,
      refresh_expires_at = credential_refresh_commit.refresh_expires_at,
      refresh_token_digest = credential_refresh_commit.refresh_token_digest,
      refreshing_until = CASE WHEN k.refresh_fencing = credential_refresh_commit.expected_fencing THEN NULL
        ELSE k.refreshing_until END,
      refresh_owner = CASE WHEN k.refresh_fencing = credential_refresh_commit.expected_fencing THEN NULL
        ELSE k.refresh_owner END,
      refresh_attempt_outcome = CASE WHEN k.refresh_fencing = credential_refresh_commit.expected_fencing THEN 'ok'
        ELSE k.refresh_attempt_outcome END
    WHERE k.workspace_id = credential_refresh_commit.workspace_id AND k.channel_id = credential_refresh_commit.channel_id
      AND k.kind = 'channel_token' AND k.state = 'active'
      AND k.refresh_token_digest = credential_refresh_commit.expected_digest
      AND k.generation = credential_refresh_commit.expected_generation
    RETURNING k.generation INTO new_generation;
  did_land := FOUND;
  IF did_land THEN
    UPDATE app.channels AS c SET token_expires_at = credential_refresh_commit.access_expires_at
      WHERE c.workspace_id = credential_refresh_commit.workspace_id AND c.id = credential_refresh_commit.channel_id;
  ELSE
    SELECT k.generation INTO new_generation FROM app.channel_credentials AS k
      WHERE k.workspace_id = credential_refresh_commit.workspace_id AND k.channel_id = credential_refresh_commit.channel_id
        AND k.kind = 'channel_token' AND k.state = 'active';
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN QUERY SELECT did_land, new_generation;
END
$$;

-- The outcome is unknown after a timeout, 5xx or 429, failed otherwise. Only a confirmed revocation moves a connected
-- channel to needs_reconnect. A digest or lease that moved answers 'changed' and writes nothing, so a competing
-- commit or a newer refresher is never overridden. A disabled or disconnected channel keeps its state.
CREATE FUNCTION app.credential_refresh_fail(
  workspace_id uuid, channel_id uuid, expected_digest text, expected_fencing integer, outcome text,
  state_reason text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  org uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'credential_refresh_fail', true);
  PERFORM app.credential_caller(credential_refresh_fail.workspace_id);
  IF credential_refresh_fail.outcome IS NULL OR credential_refresh_fail.outcome NOT IN ('unknown', 'failed')
     OR credential_refresh_fail.state_reason NOT IN ('revoked_confirmed', 'refresh_token_rotated_unknown') THEN
    RAISE EXCEPTION 'credential_refresh_fail: unknown outcome or state reason' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM app.channels AS c
    WHERE c.workspace_id = credential_refresh_fail.workspace_id AND c.id = credential_refresh_fail.channel_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credential_refresh_fail: refused' USING ERRCODE = '42501';
  END IF;
  UPDATE app.channel_credentials AS k SET refresh_attempt_outcome = credential_refresh_fail.outcome,
      refreshing_until = NULL, refresh_owner = NULL
    WHERE k.workspace_id = credential_refresh_fail.workspace_id AND k.channel_id = credential_refresh_fail.channel_id
      AND k.kind = 'channel_token' AND k.state = 'active'
      AND k.refresh_token_digest = credential_refresh_fail.expected_digest
      AND k.refresh_fencing = credential_refresh_fail.expected_fencing;
  IF NOT FOUND THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN 'changed';
  END IF;
  IF credential_refresh_fail.state_reason IS NOT NULL THEN
    UPDATE app.channels AS c SET connection_state = 'needs_reconnect',
        state_reason = credential_refresh_fail.state_reason,
        reconnect_deadline = coalesce(c.reconnect_deadline, clock_timestamp() + interval '30 days')
      WHERE c.workspace_id = credential_refresh_fail.workspace_id AND c.id = credential_refresh_fail.channel_id
        AND c.connection_state = 'connected';
    IF FOUND THEN
      SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = credential_refresh_fail.workspace_id;
      PERFORM app.audit_append(credential_refresh_fail.workspace_id, org, coalesce(app.principal_kind(), 'job'),
        coalesce(app.principal_id()::text, 'job'), 'channel.reconnect_needed', 'channel',
        credential_refresh_fail.channel_id::text, NULL, NULL,
        jsonb_build_object('reason', credential_refresh_fail.state_reason));
    END IF;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN 'applied';
END
$$;

-- Only credentials that hold a refresh token (a NULL digest never reaches the provider), and only in the workspaces
-- the job principal holds. It answers ids and nothing secret. The margin is bounded 60 to 3600 seconds, the limit 1 to 500.
CREATE FUNCTION app.due_token_refreshes(lim integer, margin_seconds integer)
RETURNS TABLE (workspace_id uuid, channel_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'due_token_refreshes', true);
  IF app.principal_kind() IS DISTINCT FROM 'job' THEN
    RAISE EXCEPTION 'due_token_refreshes: refused' USING ERRCODE = '42501';
  END IF;
  IF lim IS NULL OR lim NOT BETWEEN 1 AND 500 OR margin_seconds IS NULL OR margin_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'due_token_refreshes: the limit is 1 to 500 and the margin 60 to 3600 seconds' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT k.workspace_id, k.channel_id
      FROM app.channel_credentials AS k
      JOIN app.channels AS c ON c.workspace_id = k.workspace_id AND c.id = k.channel_id
      WHERE k.kind = 'channel_token' AND k.state = 'active' AND c.connection_state = 'connected'
        AND k.workspace_id = ANY (app.ws_ids()) AND k.refresh_token_digest IS NOT NULL
        AND k.access_expires_at <= clock_timestamp() + make_interval(secs => due_token_refreshes.margin_seconds)
        AND (k.refreshing_until IS NULL OR k.refreshing_until <= clock_timestamp())
      ORDER BY k.access_expires_at LIMIT due_token_refreshes.lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Nobody but the callers named here may run a definer; the helper is the definers' own.
REVOKE ALL ON FUNCTION app.credential_caller(uuid), app.workspace_salt_ensure(uuid, bytea),
  app.channel_health_record(uuid, uuid, text, text, text, timestamptz, jsonb, jsonb),
  app.channel_connect(uuid, text, text, text, text, text, text, text, uuid, text, bytea),
  app.credential_put(uuid, uuid, integer, integer, text, bytea, bytea, bytea, bytea, bytea, bytea, timestamptz,
    timestamptz, text, text, text, timestamptz, jsonb, jsonb, text, bytea),
  app.credential_open(uuid, uuid), app.credential_refresh_begin(uuid, uuid, text, integer),
  app.credential_refresh_commit(uuid, uuid, text, integer, integer, integer, text, bytea, bytea, bytea, bytea, bytea,
    bytea, timestamptz, timestamptz, text),
  app.credential_refresh_fail(uuid, uuid, text, integer, text, text), app.due_token_refreshes(integer, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspace_salt_ensure(uuid, bytea),
  app.channel_health_record(uuid, uuid, text, text, text, timestamptz, jsonb, jsonb),
  app.channel_connect(uuid, text, text, text, text, text, text, text, uuid, text, bytea),
  app.credential_put(uuid, uuid, integer, integer, text, bytea, bytea, bytea, bytea, bytea, bytea, timestamptz,
    timestamptz, text, text, text, timestamptz, jsonb, jsonb, text, bytea),
  app.credential_open(uuid, uuid), app.credential_refresh_begin(uuid, uuid, text, integer),
  app.credential_refresh_commit(uuid, uuid, text, integer, integer, integer, text, bytea, bytea, bytea, bytea, bytea,
    bytea, timestamptz, timestamptz, text),
  app.credential_refresh_fail(uuid, uuid, text, integer, text, text) TO shoutory_app, shoutory_worker;
GRANT EXECUTE ON FUNCTION app.due_token_refreshes(integer, integer) TO shoutory_worker;
RESET ROLE;
