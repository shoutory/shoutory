CALL app.grant_purposes('channels', 'SELECT', ARRAY['channel_check_begin']);
CALL app.grant_purposes('channels', 'UPDATE', ARRAY['channel_check_begin']);
-- The caller's rank is read from these.
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['channel_check_begin']);
CALL app.grant_purposes('workspace_members', 'SELECT', ARRAY['channel_check_begin']);
CALL app.grant_purposes('organization_members', 'SELECT', ARRAY['channel_check_begin']);
CALL app.grant_purposes('roles', 'SELECT', ARRAY['channel_check_begin']);

SET ROLE shoutory_definer;

-- A health check of a connected channel starts at most once a minute. The row lock makes two simultaneous checks
-- take turns, so only the first is stamped and the second is told how long to wait. A channel that is not connected
-- is answered with its state and is never stamped. wait_seconds is NULL when this call began the check.
CREATE FUNCTION app.channel_check_begin(workspace_id uuid, channel_id uuid)
RETURNS TABLE (provider_id text, connection_state text, wait_seconds float8)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  target record;
  since float8;
BEGIN
  PERFORM set_config('app.job_purpose', 'channel_check_begin', true);
  PERFORM app.credential_caller(channel_check_begin.workspace_id);
  SELECT c.provider_id, c.connection_state, c.health_checked_at INTO target FROM app.channels AS c
    WHERE c.workspace_id = channel_check_begin.workspace_id AND c.id = channel_check_begin.channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_check_begin: refused' USING ERRCODE = '42501';
  END IF;
  since := extract(epoch FROM clock_timestamp() - target.health_checked_at)::float8;
  provider_id := target.provider_id;
  connection_state := target.connection_state;
  wait_seconds := NULL;
  IF target.connection_state = 'connected' THEN
    IF since IS NOT NULL AND since < 60 THEN
      wait_seconds := 60 - since;
    ELSE
      UPDATE app.channels AS c SET health_checked_at = clock_timestamp()
        WHERE c.workspace_id = channel_check_begin.workspace_id AND c.id = channel_check_begin.channel_id;
    END IF;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION app.channel_check_begin(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.channel_check_begin(uuid, uuid) TO shoutory_app;

RESET ROLE;
