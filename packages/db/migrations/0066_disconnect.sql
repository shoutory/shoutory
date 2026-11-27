-- Disconnect keeps every row. One transaction refuses while work is in flight, or marks the channel disconnected, holds
-- its waiting operations and moves the credential to `revoking`; the provider's revoke call runs between the two
-- transactions, and a second one overwrites the secret bytes. A credential left `revoking` too long is finished by a sweep.
ALTER TABLE app.channel_credentials ADD COLUMN revoking_since timestamptz;
GRANT UPDATE (revoking_since) ON app.channel_credentials TO shoutory_definer;
ALTER TABLE app.channel_credentials DROP CONSTRAINT channel_credentials_state_check;
ALTER TABLE app.channel_credentials ADD CONSTRAINT channel_credentials_state_check
  CHECK (state IN ('active', 'read_only', 'superseded', 'revoking', 'destroyed')) NOT VALID;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations', 'workspaces'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['channel_disconnect']);
    CALL app.grant_purposes(t, 'UPDATE', ARRAY['channel_disconnect']);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['channel_disconnect', 'credential_destroy']);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['workspaces'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['credential_destroy']);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['posts', 'post_variants', 'operations', 'channels', 'channel_credentials'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['channel_disconnect']);
    CALL app.grant_purposes(t, 'UPDATE', ARRAY['channel_disconnect']);
  END LOOP;
END
$$;
CALL app.grant_purposes('channel_credentials', 'SELECT', ARRAY['credential_destroy', 'credentials_revoking_stale']);
CALL app.grant_purposes('channel_credentials', 'UPDATE', ARRAY['credential_destroy']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['credentials_revoking_stale']);

SET ROLE shoutory_definer;

CREATE POLICY channel_disconnect_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'channel_disconnect');

-- The ids of the operations that block the disconnect, in a refusal that writes nothing; an empty list means the channel
-- is now disconnected. The caller took the channel advisory lock before this call. The posts and variants of the
-- waiting operations are locked first, then the channel row, then the operations, in rank order.
CREATE FUNCTION app.channel_disconnect(workspace_id uuid, channel_id uuid, request_id text, ip_hmac bytea)
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
  SELECT coalesce(array_agg(o.id ORDER BY o.id), '{}') INTO blocking FROM (
    SELECT o2.id FROM app.operations AS o2
      WHERE o2.workspace_id = channel_disconnect.workspace_id AND o2.channel_id = channel_disconnect.channel_id
        AND o2.state IN ('claimed', 'dispatching', 'provider_accepted', 'unknown_external_state', 'reconciling',
          'needs_human', 'unverified')
      ORDER BY o2.id FOR NO KEY UPDATE) AS o;
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
      ORDER BY o.id FOR NO KEY UPDATE
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

-- Overwrites every secret byte of the channel's credential that is being revoked and ends it. A person who may manage
-- the channel calls it after the disconnect, and the recovery sweep calls it as the job. Returns how many it destroyed.
CREATE FUNCTION app.credential_destroy(workspace_id uuid, channel_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  kind constant text := app.principal_kind();
  destroyed integer;
BEGIN
  IF kind = 'job' THEN
    PERFORM app.ledger_caller();
  ELSIF kind IS DISTINCT FROM 'user' OR app.principal_id() IS NULL
     OR app.tenancy_rank(credential_destroy.workspace_id, app.principal_id()) < 4 THEN
    RAISE EXCEPTION 'credential_destroy: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.job_purpose', 'credential_destroy', true);
  UPDATE app.channel_credentials AS k SET ciphertext = '\x'::bytea, iv = '\x'::bytea, auth_tag = '\x'::bytea,
      wrap_iv = '\x'::bytea, wrap_tag = '\x'::bytea, wrapped_dek = '\x'::bytea, refresh_token_digest = NULL,
      refresh_attempt_digest = NULL, state = 'destroyed'
    WHERE k.workspace_id = credential_destroy.workspace_id AND k.channel_id = credential_destroy.channel_id
      AND k.state = 'revoking';
  GET DIAGNOSTICS destroyed = ROW_COUNT;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN destroyed;
END
$$;

-- The channels whose credential has been `revoking` for the given time, for the sweep that finishes them.
CREATE FUNCTION app.credentials_revoking_stale(p_age interval)
RETURNS TABLE (workspace_id uuid, channel_id uuid, provider_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'credentials_revoking_stale', true);
  RETURN QUERY
    SELECT k.workspace_id, k.channel_id, c.provider_id FROM app.channel_credentials AS k
      JOIN app.channels AS c ON c.workspace_id = k.workspace_id AND c.id = k.channel_id
      WHERE k.state = 'revoking' AND k.revoking_since <= clock_timestamp() - p_age
      ORDER BY k.id LIMIT 100;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.channel_disconnect(uuid, uuid, text, bytea), app.credential_destroy(uuid, uuid),
  app.credentials_revoking_stale(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.channel_disconnect(uuid, uuid, text, bytea), app.credential_destroy(uuid, uuid)
  TO shoutory_app;
GRANT EXECUTE ON FUNCTION app.credential_destroy(uuid, uuid), app.credentials_revoking_stale(interval)
  TO shoutory_worker;

RESET ROLE;
