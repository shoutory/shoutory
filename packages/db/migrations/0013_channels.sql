-- A query through the parent applies the parent's policies and ignores the leaf's; a query that names a leaf applies
-- the leaf's, and a leaf with no row security would be readable by any role holding a grant (PostgreSQL 18, ddl-inherit
-- and ddl-rowsecurity, accessed 2026-11-21). The loop reads the catalog, so no leaf is missed. The leaves belong to
-- the definer role, so it runs the statements. They take ACCESS EXCLUSIVE on each leaf for this transaction only.
SET ROLE shoutory_definer;
-- shoutory:accepted-lock three small leaves, held only for this migration transaction
DO $$
DECLARE
  leaf regclass;
BEGIN
  FOR leaf IN SELECT i.inhrelid::regclass FROM pg_catalog.pg_inherits AS i WHERE i.inhparent = 'app.audit_logs'::regclass LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', leaf);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', leaf);
  END LOOP;
END
$$;

REVOKE EXECUTE ON FUNCTION app.audit_insert(text, text, text, text, bytea, jsonb) FROM shoutory_worker;
RESET ROLE;

-- The route passes the bucket key, a keyed digest of the user id that only the application can compute; bucket_take
-- refuses a key that is not 64 lower-case hex digits. The scope list is widened for scopes whose numbers come later:
-- bucket_limits has none, so bucket_take refuses them until then.
-- shoutory:accepted-lock the throttle table is small and its rows expire; the lock is held for this migration only
ALTER TABLE app.rate_buckets DROP CONSTRAINT rate_buckets_scope_check;
-- shoutory:accepted-lock same small table, same transaction
ALTER TABLE app.rate_buckets ADD CONSTRAINT rate_buckets_scope_check CHECK (scope IN (
  'login_account', 'login_ip', 'verification_resend', 'invite', 'invite_accept', 'unsubscribe',
  'two_factor', 'password_reset', 'totp_code', 'link_confirm', 'tenant_create',
  'account', 'chat', 'webhook', 'instance', 'app', 'api_principal')) NOT VALID;
-- shoutory:accepted-lock VALIDATE takes SHARE UPDATE EXCLUSIVE and scans the same small table, in the same transaction
ALTER TABLE app.rate_buckets VALIDATE CONSTRAINT rate_buckets_scope_check;

-- The definer role owns bucket_limits and the migration owner does not inherit its rights, so the replacement runs
-- as the definer.
SET ROLE shoutory_definer;
CREATE OR REPLACE FUNCTION app.bucket_limits(scope text)
RETURNS TABLE (capacity integer, refill_seconds integer)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT l.capacity, l.refill_seconds FROM (VALUES
    ('login_account', 100, 86400),
    ('login_ip', 60, 900),
    ('verification_resend', 5, 3600),
    ('two_factor', 10, 900),
    ('password_reset', 5, 3600),
    ('totp_code', 1, 90),
    ('link_confirm', 20, 900),
    ('invite', 20, 3600),
    ('invite_accept', 10, 900),
    ('unsubscribe', 20, 900),
    ('tenant_create', 10, 86400)
  ) AS l (name, capacity, refill_seconds) WHERE l.name = scope
$$;
REVOKE ALL ON FUNCTION app.bucket_limits(text) FROM PUBLIC;
DROP FUNCTION app.workspace_create(uuid, text, text, text, text, bytea);
DROP FUNCTION app.organization_create(text, text, text, bytea);
RESET ROLE;

-- A refusal is SQLSTATE SH429 with the whole seconds to wait in DETAIL; the transaction rolls back, so a refused
-- call creates nothing and a later failure of the same call gives the token back. The spend comes after the
-- organization lock and the workspace cap, so a call the cap refuses never reaches the bucket.
CREATE FUNCTION app.organization_create(name text, type text, request_id text, ip_hmac bytea, bucket_key text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  new_id constant uuid := uuidv7();
  owned integer;
  spent record;
BEGIN
  PERFORM set_config('app.job_purpose', 'organization_create', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'organization_create refuses this caller' USING ERRCODE = '42501';
  END IF;
  SELECT t.allowed, t.retry_after_seconds INTO spent
    FROM app.bucket_take(organization_create.bucket_key, 'tenant_create', 1) AS t;
  IF NOT spent.allowed THEN
    RAISE EXCEPTION 'organization_create: rate_limited' USING ERRCODE = 'SH429',
      DETAIL = format('retry after %s seconds', spent.retry_after_seconds);
  END IF;
  INSERT INTO app.organizations (id, name, slug, type)
    VALUES (new_id, organization_create.name, 'o-' || replace(new_id::text, '-', ''), organization_create.type);
  INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES (new_id, caller, 'owner');
  PERFORM app.audit_append(NULL, new_id, 'user', caller::text, 'organization.created', 'organization', new_id::text,
    organization_create.request_id, organization_create.ip_hmac, '{}');
  SELECT count(*) INTO owned FROM app.organization_members AS m WHERE m.user_id = caller AND m.org_role = 'owner';
  IF owned > 20 THEN
    RAISE EXCEPTION 'organization_create: at most 20 owned organizations' USING ERRCODE = '53400';
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;

CREATE FUNCTION app.workspace_create(
  organization_id uuid, name text, slug text, tz text, request_id text, ip_hmac bytea, bucket_key text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  new_id constant uuid := uuidv7();
  owner_role uuid;
  spent record;
BEGIN
  PERFORM set_config('app.job_purpose', 'workspace_create', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user'
     OR NOT EXISTS (SELECT 1 FROM app.organization_members AS m
                    WHERE m.organization_id = workspace_create.organization_id AND m.user_id = caller
                      AND m.org_role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'workspace_create refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS z WHERE z.name = workspace_create.tz) THEN
    RAISE EXCEPTION 'workspace_create: unknown time zone' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM app.organizations AS o WHERE o.id = workspace_create.organization_id FOR NO KEY UPDATE;
  IF NOT EXISTS (SELECT 1 FROM app.organization_members AS m
                 WHERE m.organization_id = workspace_create.organization_id AND m.user_id = caller
                   AND m.org_role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'workspace_create refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM app.workspaces AS w WHERE w.organization_id = workspace_create.organization_id) >= 100 THEN
    RAISE EXCEPTION 'workspace_create: at most 100 workspaces per organization' USING ERRCODE = '53400';
  END IF;
  SELECT t.allowed, t.retry_after_seconds INTO spent
    FROM app.bucket_take(workspace_create.bucket_key, 'tenant_create', 1) AS t;
  IF NOT spent.allowed THEN
    RAISE EXCEPTION 'workspace_create: rate_limited' USING ERRCODE = 'SH429',
      DETAIL = format('retry after %s seconds', spent.retry_after_seconds);
  END IF;
  SELECT r.id INTO owner_role FROM app.roles AS r WHERE r.workspace_id IS NULL AND r.key = 'owner';
  INSERT INTO app.workspaces (id, organization_id, name, slug, default_tz)
    VALUES (new_id, workspace_create.organization_id, workspace_create.name, workspace_create.slug,
            workspace_create.tz);
  INSERT INTO app.workspace_members (workspace_id, user_id, role_id) VALUES (new_id, caller, owner_role);
  PERFORM app.audit_append(new_id, workspace_create.organization_id, 'user', caller::text, 'workspace.created',
    'workspace', new_id::text, workspace_create.request_id, workspace_create.ip_hmac, '{}');
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;

REVOKE ALL ON FUNCTION app.organization_create(text, text, text, bytea, text),
  app.workspace_create(uuid, text, text, text, text, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organization_create(text, text, text, bytea, text),
  app.workspace_create(uuid, text, text, text, text, bytea, text) TO shoutory_app;
ALTER FUNCTION app.organization_create(text, text, text, bytea, text) OWNER TO shoutory_definer;
ALTER FUNCTION app.workspace_create(uuid, text, text, text, text, bytea, text) OWNER TO shoutory_definer;

-- No runtime role inserts or deletes a row. connection_state and state_reason change only through definers that
-- check the move; the app role may write the nickname column alone. The default state is the safe one: admission
-- trusts `connected`, and only a definer that holds a usable credential sets it.
-- provider_id and account_kind are open text bounded in length: providers and their account kinds belong to the
-- provider manifests, not to a constraint here.
CREATE TABLE app.channels (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 64),
  account_kind text NOT NULL CHECK (char_length(account_kind) BETWEEN 1 AND 32),
  provider_account_id text NOT NULL CHECK (char_length(provider_account_id) BETWEEN 1 AND 256),
  instance_host text CHECK (char_length(instance_host) BETWEEN 1 AND 253),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
  handle text CHECK (char_length(handle) BETWEEN 1 AND 256),
  nickname text CHECK (char_length(nickname) BETWEEN 1 AND 200),
  avatar text CHECK (char_length(avatar) BETWEEN 1 AND 2048),
  connection_state text NOT NULL DEFAULT 'needs_reconnect' CHECK (connection_state IN (
    'connected', 'needs_reconnect', 'disconnected', 'revoked_by_provider', 'disabled')),
  state_reason text CHECK (state_reason IN (
    'admin_disabled', 'entitlement', 'refresh_token_rotated_unknown', 'revoked_confirmed', 'deauthorized',
    'provider_app_changed')),
  health text CHECK (health IN ('ok', 'degraded', 'failing')),
  health_checked_at timestamptz,
  disconnected_at timestamptz,
  reconnect_deadline timestamptz,
  token_expires_at timestamptz,
  last_reauth_notice timestamptz,
  capability_epoch integer NOT NULL DEFAULT 0 CHECK (capability_epoch >= 0),
  CONSTRAINT channels_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT channels_identity_key UNIQUE (workspace_id, provider_id, provider_account_id)
);
SELECT app.apply_rls_template('app.channels'::regclass, 'W');
GRANT SELECT ON app.channels TO shoutory_app;
GRANT UPDATE (nickname) ON app.channels TO shoutory_app;

CREATE TABLE app.channel_capability_snapshots (
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  epoch integer NOT NULL CHECK (epoch >= 0),
  manifest_digest text NOT NULL CHECK (char_length(manifest_digest) BETWEEN 1 AND 128),
  api_version text NOT NULL CHECK (char_length(api_version) BETWEEN 1 AND 64),
  sunset_at timestamptz,
  capabilities jsonb NOT NULL CHECK (octet_length(capabilities::text) <= 65536),
  limits jsonb NOT NULL CHECK (octet_length(limits::text) <= 65536),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, channel_id, epoch),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES app.channels (workspace_id, id) ON DELETE CASCADE
);
SELECT app.apply_rls_template('app.channel_capability_snapshots'::regclass, 'W');
GRANT SELECT ON app.channel_capability_snapshots TO shoutory_app;

CREATE TABLE app.sync_cursors (
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  stream text NOT NULL CHECK (stream IN ('telegram_updates', 'comments', 'mentions', 'dms', 'metrics', 'import')),
  cursor text NOT NULL CHECK (char_length(cursor) <= 2048),
  synced_at timestamptz,
  next_sync_at timestamptz,
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  PRIMARY KEY (workspace_id, channel_id, stream),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES app.channels (workspace_id, id) ON DELETE CASCADE
);
SELECT app.apply_rls_template('app.sync_cursors'::regclass, 'W');
GRANT SELECT ON app.sync_cursors TO shoutory_app;

-- Instance-level, read and written only by definers; the explicit policy denies the runtime roles. The client secret
-- is stored sealed, one column per field of the sealed secret.
CREATE TABLE app.provider_apps (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 64),
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 512),
  redirect_uri text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
  app_token text CHECK (char_length(app_token) BETWEEN 16 AND 128),
  active boolean NOT NULL DEFAULT true,
  secret_ciphertext bytea NOT NULL,
  secret_iv bytea NOT NULL,
  secret_auth_tag bytea NOT NULL,
  secret_wrap_iv bytea NOT NULL,
  secret_wrap_tag bytea NOT NULL,
  secret_wrapped_dek bytea NOT NULL,
  secret_key_id text NOT NULL CHECK (secret_key_id ~ '^[a-z0-9-]{1,32}$'),
  secret_format_version integer NOT NULL,
  secret_generation integer NOT NULL
);
-- shoutory:accepted-lock new empty table in this file
CREATE UNIQUE INDEX provider_apps_active_key ON app.provider_apps (provider_id, environment) WHERE active;
SELECT app.apply_rls_template('app.provider_apps'::regclass, 'I');
CREATE POLICY provider_apps_deny_runtime ON app.provider_apps FOR ALL TO shoutory_app, shoutory_worker
  USING (false) WITH CHECK (false);

CREATE TABLE app.provider_instance_apps (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 64),
  instance_host text NOT NULL CHECK (char_length(instance_host) BETWEEN 1 AND 253),
  client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 512),
  secret_ciphertext bytea NOT NULL,
  secret_iv bytea NOT NULL,
  secret_auth_tag bytea NOT NULL,
  secret_wrap_iv bytea NOT NULL,
  secret_wrap_tag bytea NOT NULL,
  secret_wrapped_dek bytea NOT NULL,
  secret_key_id text NOT NULL CHECK (secret_key_id ~ '^[a-z0-9-]{1,32}$'),
  secret_format_version integer NOT NULL,
  secret_generation integer NOT NULL,
  CONSTRAINT provider_instance_apps_host_key UNIQUE (provider_id, instance_host)
);
SELECT app.apply_rls_template('app.provider_instance_apps'::regclass, 'I');
CREATE POLICY provider_instance_apps_deny_runtime ON app.provider_instance_apps FOR ALL
  TO shoutory_app, shoutory_worker USING (false) WITH CHECK (false);

-- Locks are taken in rank order: the tenancy locks, then the channel row, then the audit head inside audit_append.
-- The caller needs channels.manage (the admin rank). A caller outside the workspace, a channel of another workspace
-- and a missing channel all get the same 42501.
GRANT SELECT ON app.channels TO shoutory_definer;
GRANT UPDATE (connection_state, state_reason, reconnect_deadline) ON app.channels TO shoutory_definer;
CALL app.grant_purposes('channels', 'SELECT', ARRAY['channel_disable', 'channel_enable']);
CALL app.grant_purposes('channels', 'UPDATE', ARRAY['channel_disable', 'channel_enable']);
CALL app.grant_purposes('organizations', 'SELECT', ARRAY['channel_disable', 'channel_enable']);
CALL app.grant_purposes('organizations', 'UPDATE', ARRAY['channel_disable', 'channel_enable']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['channel_disable', 'channel_enable']);
CALL app.grant_purposes('workspaces', 'UPDATE', ARRAY['channel_disable', 'channel_enable']);
CALL app.grant_purposes('workspace_members', 'SELECT', ARRAY['channel_disable', 'channel_enable']);
CALL app.grant_purposes('organization_members', 'SELECT', ARRAY['channel_disable', 'channel_enable']);
CALL app.grant_purposes('roles', 'SELECT', ARRAY['channel_disable', 'channel_enable']);

CREATE FUNCTION app.channel_disable(workspace_id uuid, channel_id uuid, request_id text, ip_hmac bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  target record;
  org uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'channel_disable', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'channel_disable: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM app.tenancy_enter('channel_disable', channel_disable.workspace_id, caller, 4);
  SELECT c.connection_state, c.provider_id INTO target FROM app.channels AS c
    WHERE c.workspace_id = channel_disable.workspace_id AND c.id = channel_disable.channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_disable: refused' USING ERRCODE = '42501';
  END IF;
  IF target.connection_state = 'disabled' THEN
    RAISE EXCEPTION 'channel_disable: already_ended' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.channels AS c SET connection_state = 'disabled', state_reason = 'admin_disabled'
    WHERE c.workspace_id = channel_disable.workspace_id AND c.id = channel_disable.channel_id;
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = channel_disable.workspace_id;
  PERFORM app.audit_append(channel_disable.workspace_id, org, 'user', caller::text, 'channel.disabled', 'channel',
    channel_disable.channel_id::text, channel_disable.request_id, channel_disable.ip_hmac,
    jsonb_build_object('provider_id', target.provider_id, 'was', target.connection_state));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Enabling never sets `connected`: nothing here proves a credential usable, so the channel becomes needs_reconnect,
-- with a 30-day reconnect window counted from the first needs_reconnect (an earlier deadline is kept).
CREATE FUNCTION app.channel_enable(workspace_id uuid, channel_id uuid, request_id text, ip_hmac bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  target record;
  org uuid;
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
  UPDATE app.channels AS c SET connection_state = 'needs_reconnect', state_reason = NULL,
      reconnect_deadline = coalesce(c.reconnect_deadline, clock_timestamp() + interval '30 days')
    WHERE c.workspace_id = channel_enable.workspace_id AND c.id = channel_enable.channel_id;
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = channel_enable.workspace_id;
  PERFORM app.audit_append(channel_enable.workspace_id, org, 'user', caller::text, 'channel.enabled', 'channel',
    channel_enable.channel_id::text, channel_enable.request_id, channel_enable.ip_hmac,
    jsonb_build_object('provider_id', target.provider_id));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.channel_disable(uuid, uuid, text, bytea), app.channel_enable(uuid, uuid, text, bytea)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.channel_disable(uuid, uuid, text, bytea), app.channel_enable(uuid, uuid, text, bytea)
  TO shoutory_app;
ALTER FUNCTION app.channel_disable(uuid, uuid, text, bytea) OWNER TO shoutory_definer;
ALTER FUNCTION app.channel_enable(uuid, uuid, text, bytea) OWNER TO shoutory_definer;
