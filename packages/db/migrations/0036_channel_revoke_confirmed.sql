CALL app.grant_purposes('channels', 'SELECT', ARRAY['channel_revoke_confirmed']);
CALL app.grant_purposes('channels', 'UPDATE', ARRAY['channel_revoke_confirmed']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['channel_revoke_confirmed']);

SET ROLE shoutory_definer;

-- The provider's own credential check answered that the grant is gone, for a channel that holds no refresh token: the
-- channel waits for a reconnect, and its operations follow it. A channel that is not connected is left as it is.
CREATE FUNCTION app.channel_revoke_confirmed(workspace_id uuid, channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  org uuid;
  moved boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'channel_revoke_confirmed', true);
  PERFORM app.credential_caller(channel_revoke_confirmed.workspace_id);
  UPDATE app.channels AS c SET connection_state = 'needs_reconnect', state_reason = 'revoked_confirmed',
      reconnect_deadline = coalesce(c.reconnect_deadline, clock_timestamp() + interval '30 days')
    WHERE c.workspace_id = channel_revoke_confirmed.workspace_id AND c.id = channel_revoke_confirmed.channel_id
      AND c.connection_state = 'connected';
  moved := FOUND;
  IF moved THEN
    SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = channel_revoke_confirmed.workspace_id;
    PERFORM app.audit_append(channel_revoke_confirmed.workspace_id, org, coalesce(app.principal_kind(), 'job'),
      coalesce(app.principal_id()::text, 'job'), 'channel.reconnect_needed', 'channel',
      channel_revoke_confirmed.channel_id::text, NULL, NULL, jsonb_build_object('reason', 'revoked_confirmed'));
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN moved;
END
$$;

REVOKE ALL ON FUNCTION app.channel_revoke_confirmed(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.channel_revoke_confirmed(uuid, uuid) TO shoutory_worker;

RESET ROLE;
