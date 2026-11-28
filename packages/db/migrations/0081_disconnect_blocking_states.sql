-- An operation that the media pipeline is preparing for the provider also stands in the way of a disconnect, and the
-- refusal names at most 201 operations (the caller shows 200 and says there are more).
SET ROLE shoutory_definer;

CREATE OR REPLACE FUNCTION app.channel_disconnect(workspace_id uuid, channel_id uuid, request_id text, ip_hmac bytea)
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  target record;
  org uuid;
  blocking uuid[] := '{}';
  r record;
BEGIN
  PERFORM set_config('app.job_purpose', 'channel_disconnect', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'channel_disconnect: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM app.tenancy_enter('channel_disconnect', channel_disconnect.workspace_id, caller, 4);
  PERFORM 1 FROM app.posts AS p
    JOIN app.post_variants AS v ON v.workspace_id = p.workspace_id AND v.post_id = p.id
    JOIN app.operations AS o ON o.workspace_id = v.workspace_id AND o.variant_id = v.id
    WHERE o.workspace_id = channel_disconnect.workspace_id AND o.channel_id = channel_disconnect.channel_id
      AND o.state IN ('pending', 'retry_wait', 'paused')
    ORDER BY p.id, v.id FOR NO KEY UPDATE OF p, v;
  SELECT c.connection_state, c.provider_id INTO target FROM app.channels AS c
    WHERE c.workspace_id = channel_disconnect.workspace_id AND c.id = channel_disconnect.channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_disconnect: refused' USING ERRCODE = '42501';
  END IF;
  IF target.connection_state = 'disconnected' THEN
    RAISE EXCEPTION 'channel_disconnect: already_ended' USING ERRCODE = 'SH409';
  END IF;
  PERFORM 1 FROM app.operations AS o2
    WHERE o2.workspace_id = channel_disconnect.workspace_id AND o2.channel_id = channel_disconnect.channel_id
      AND o2.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')
    ORDER BY o2.id FOR NO KEY UPDATE;
  SELECT coalesce(array_agg(b.id ORDER BY b.id), '{}') INTO blocking FROM (
    SELECT o.id FROM app.operations AS o
      WHERE o.workspace_id = channel_disconnect.workspace_id AND o.channel_id = channel_disconnect.channel_id
        AND o.state IN ('claimed', 'processing', 'dispatching', 'provider_accepted', 'unknown_external_state',
          'reconciling', 'needs_human', 'unverified')
      ORDER BY o.id LIMIT 201) AS b;
  IF cardinality(blocking) > 0 THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN blocking;
  END IF;
  PERFORM 1 FROM app.channel_credentials AS k
    WHERE k.workspace_id = channel_disconnect.workspace_id AND k.channel_id = channel_disconnect.channel_id
      AND k.state IN ('active', 'read_only')
    ORDER BY k.id FOR NO KEY UPDATE;
  FOR r IN
    SELECT o.id AS oid, o.state AS was FROM app.operations AS o
      WHERE o.workspace_id = channel_disconnect.workspace_id AND o.channel_id = channel_disconnect.channel_id
        AND o.state IN ('pending', 'retry_wait', 'paused')
      ORDER BY o.id
  LOOP
    UPDATE app.operations AS o SET state = 'blocked_reconnect', last_actor = 'S', reason_code = 'pending',
        blocked_since = clock_timestamp()
      WHERE o.workspace_id = channel_disconnect.workspace_id AND o.id = r.oid;
    INSERT INTO app.outbox (workspace_id, type, payload)
      VALUES (channel_disconnect.workspace_id, 'operation.blocked_reconnect',
        jsonb_build_object('operation_id', r.oid, 'from', r.was, 'to', 'blocked_reconnect'));
  END LOOP;
  UPDATE app.channels AS c SET connection_state = 'disconnected', state_reason = NULL, disabled_from_state = NULL,
      disconnected_at = clock_timestamp(), reconnect_deadline = clock_timestamp() + interval '30 days'
    WHERE c.workspace_id = channel_disconnect.workspace_id AND c.id = channel_disconnect.channel_id;
  UPDATE app.channel_credentials AS k SET state = 'revoking', revoking_since = clock_timestamp()
    WHERE k.workspace_id = channel_disconnect.workspace_id AND k.channel_id = channel_disconnect.channel_id
      AND k.state IN ('active', 'read_only');
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = channel_disconnect.workspace_id;
  PERFORM app.audit_append(channel_disconnect.workspace_id, org, 'user', caller::text, 'channel.disconnected',
    'channel', channel_disconnect.channel_id::text, channel_disconnect.request_id, channel_disconnect.ip_hmac,
    jsonb_build_object('provider_id', target.provider_id, 'was', target.connection_state));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN '{}';
END
$$;

REVOKE ALL ON FUNCTION app.channel_disconnect(uuid, uuid, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.channel_disconnect(uuid, uuid, text, bytea) TO shoutory_app;

RESET ROLE;
