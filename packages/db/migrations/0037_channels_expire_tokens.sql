-- NOT VALID so no long lock is held; validated in its own file. Every row that satisfied the old check satisfies this
-- one.
ALTER TABLE app.channels DROP CONSTRAINT channels_state_reason_check;
ALTER TABLE app.channels ADD CONSTRAINT channels_state_reason_check CHECK (state_reason IN (
  'admin_disabled', 'entitlement', 'refresh_token_rotated_unknown', 'revoked_confirmed', 'deauthorized',
  'provider_app_changed', 'token_expired')) NOT VALID;

CALL app.grant_purposes('channels', 'SELECT', ARRAY['channels_expire_tokens']);
CALL app.grant_purposes('channels', 'UPDATE', ARRAY['channels_expire_tokens']);
CALL app.grant_purposes('channel_credentials', 'SELECT', ARRAY['channels_expire_tokens']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['channels_expire_tokens']);

SET ROLE shoutory_definer;

-- Only the refresh sweep may call it. A connected channel whose token has passed and that holds no refresh token can
-- send nothing more: it waits for a reconnect. A token with no expiry lives until the provider says otherwise and is
-- never expired here. The limit is 1 to 500.
CREATE FUNCTION app.channels_expire_tokens(lim integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  expired record;
  org uuid;
  moved integer := 0;
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'job' OR prior IS DISTINCT FROM 'credential_refresh' THEN
    RAISE EXCEPTION 'channels_expire_tokens: refused' USING ERRCODE = '42501';
  END IF;
  IF lim IS NULL OR lim NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'channels_expire_tokens: the limit is 1 to 500' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'channels_expire_tokens', true);
  FOR expired IN
    WITH picked AS (
      SELECT c.workspace_id, c.id
        FROM app.channels AS c
        JOIN app.channel_credentials AS k ON k.workspace_id = c.workspace_id AND k.channel_id = c.id
        WHERE c.connection_state = 'connected' AND k.kind = 'channel_token' AND k.state = 'active'
          AND k.refresh_token_digest IS NULL AND k.access_expires_at <= clock_timestamp()
        ORDER BY k.access_expires_at
        LIMIT channels_expire_tokens.lim
        FOR UPDATE OF c SKIP LOCKED
    )
    UPDATE app.channels AS c SET connection_state = 'needs_reconnect', state_reason = 'token_expired',
        reconnect_deadline = coalesce(c.reconnect_deadline, clock_timestamp() + interval '30 days')
      FROM picked WHERE c.workspace_id = picked.workspace_id AND c.id = picked.id
      RETURNING c.workspace_id, c.id
  LOOP
    SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = expired.workspace_id;
    PERFORM app.audit_append(expired.workspace_id, org, 'job', coalesce(app.principal_id()::text, 'job'),
      'channel.reconnect_needed', 'channel', expired.id::text, NULL, NULL, jsonb_build_object('reason', 'token_expired'));
    moved := moved + 1;
  END LOOP;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN moved;
END
$$;

REVOKE ALL ON FUNCTION app.channels_expire_tokens(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.channels_expire_tokens(integer) TO shoutory_worker;

RESET ROLE;
