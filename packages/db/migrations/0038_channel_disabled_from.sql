-- The state a channel had when it was disabled, so enabling it never turns a channel that was waiting for a
-- reconnect back into a connected one. NOT VALID so no long lock is held; validated in its own file.
ALTER TABLE app.channels ADD COLUMN disabled_from_state text;
ALTER TABLE app.channels ADD CONSTRAINT channels_disabled_from_state_check CHECK (disabled_from_state IN (
  'connected', 'needs_reconnect', 'disconnected', 'revoked_by_provider')) NOT VALID;
GRANT UPDATE (disabled_from_state) ON app.channels TO shoutory_definer;

SET ROLE shoutory_definer;

CREATE OR REPLACE FUNCTION app.channel_disable(workspace_id uuid, channel_id uuid, request_id text, ip_hmac bytea)
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
  UPDATE app.channels AS c SET connection_state = 'disabled', state_reason = 'admin_disabled',
      disabled_from_state = target.connection_state
    WHERE c.workspace_id = channel_disable.workspace_id AND c.id = channel_disable.channel_id;
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = channel_disable.workspace_id;
  PERFORM app.audit_append(channel_disable.workspace_id, org, 'user', caller::text, 'channel.disabled', 'channel',
    channel_disable.channel_id::text, channel_disable.request_id, channel_disable.ip_hmac,
    jsonb_build_object('provider_id', target.provider_id, 'was', target.connection_state));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Enable restores `connected` only for a channel that was connected when it was disabled (a channel disabled before
-- the state was kept counts as connected) and that holds a usable credential: an active channel_token row whose
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
  SELECT c.connection_state, c.provider_id, c.disabled_from_state INTO target FROM app.channels AS c
    WHERE c.workspace_id = channel_enable.workspace_id AND c.id = channel_enable.channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_enable: refused' USING ERRCODE = '42501';
  END IF;
  IF target.connection_state <> 'disabled' THEN
    RAISE EXCEPTION 'channel_enable: not_disabled' USING ERRCODE = 'SH409';
  END IF;
  SELECT coalesce(target.disabled_from_state, 'connected') = 'connected' AND EXISTS (
      SELECT 1 FROM app.channel_credentials AS k
      WHERE k.workspace_id = channel_enable.workspace_id AND k.channel_id = channel_enable.channel_id
        AND k.kind = 'channel_token' AND k.state = 'active'
        AND (k.refresh_expires_at IS NULL OR k.refresh_expires_at > clock_timestamp())) INTO usable;
  UPDATE app.channels AS c SET state_reason = NULL, disabled_from_state = NULL,
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

-- A snapshot is written only when the answer changed from the latest one (the channel epoch moves with it) and the
-- last 5 are kept. Health is written only on a connected channel, so a late check never marks a channel that is
-- waiting for a reconnect or disabled as healthy; a NULL health leaves the health columns alone, so credential_put
-- can use this for the first snapshot. True means a snapshot was written.
CREATE OR REPLACE FUNCTION app.channel_health_record(
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
      WHERE c.workspace_id = channel_health_record.workspace_id AND c.id = channel_health_record.channel_id
        AND c.connection_state = 'connected';
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN changed;
END
$$;

RESET ROLE;
