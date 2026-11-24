-- No runtime role can touch the app table; the two definers are its only way in, and only for a signed-in user who may
-- manage channels, never a job or a service. An app belongs to the instance and is shared by every workspace that
-- connects to it, by design: its secret is the provider's registration on that server, not a workspace's.
-- `p_replaces` comes only from that instance's own `invalid_client` answer to the token step.
GRANT SELECT, INSERT, DELETE ON app.provider_instance_apps TO shoutory_definer;
CALL app.grant_purposes('provider_instance_apps', 'SELECT', ARRAY['instance_app_get', 'instance_app_put']);
CALL app.grant_purposes('provider_instance_apps', 'INSERT', ARRAY['instance_app_put']);
CALL app.grant_purposes('provider_instance_apps', 'DELETE', ARRAY['instance_app_put']);
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['instance_app_get', 'instance_app_put']);
  END LOOP;
END
$$;

SET ROLE shoutory_definer;

-- The sealed fields leave only for a caller who may manage channels of the workspace; every other caller gets the same
-- refusal.
CREATE FUNCTION app.instance_app_get(p_ws uuid, p_provider text, p_host text)
RETURNS TABLE (
  id uuid, client_id text, format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea,
  wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
BEGIN
  PERFORM set_config('app.job_purpose', 'instance_app_get', true);
  IF app.principal_kind() IS DISTINCT FROM 'user' OR caller IS NULL OR app.tenancy_rank(p_ws, caller) < 4 THEN
    RAISE EXCEPTION 'instance_app_get: refused' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.id, a.client_id, a.secret_format_version, a.secret_key_id, a.secret_iv, a.secret_ciphertext,
        a.secret_auth_tag, a.secret_wrap_iv, a.secret_wrap_tag, a.secret_wrapped_dek
      FROM app.provider_instance_apps AS a
      WHERE a.provider_id = p_provider AND a.instance_host = p_host;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The first writer of a (provider, host) wins; a second is told false and writes nothing, so the loser rereads the
-- winner. A replace deletes only while the row still carries the client id it names, so a late replace never
-- overwrites a newer app.
CREATE FUNCTION app.instance_app_put(
  p_id uuid, p_ws uuid, p_provider text, p_host text, p_client_id text, format_version integer, key_id text, iv bytea,
  ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea, p_replaces text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  written integer;
  removed integer := 0;
  org uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'instance_app_put', true);
  IF app.principal_kind() IS DISTINCT FROM 'user' OR caller IS NULL OR app.tenancy_rank(p_ws, caller) < 4 THEN
    RAISE EXCEPTION 'instance_app_put: refused' USING ERRCODE = '42501';
  END IF;
  IF p_replaces IS NOT NULL THEN
    DELETE FROM app.provider_instance_apps AS a
      WHERE a.provider_id = p_provider AND a.instance_host = p_host AND a.client_id = p_replaces;
    GET DIAGNOSTICS removed = ROW_COUNT;
  END IF;
  INSERT INTO app.provider_instance_apps (id, provider_id, instance_host, client_id, secret_ciphertext, secret_iv,
      secret_auth_tag, secret_wrap_iv, secret_wrap_tag, secret_wrapped_dek, secret_key_id, secret_format_version,
      secret_generation)
    VALUES (p_id, p_provider, p_host, p_client_id, instance_app_put.ciphertext, instance_app_put.iv,
      instance_app_put.auth_tag, instance_app_put.wrap_iv, instance_app_put.wrap_tag, instance_app_put.wrapped_dek,
      instance_app_put.key_id, instance_app_put.format_version, 1)
    ON CONFLICT (provider_id, instance_host) DO NOTHING;
  GET DIAGNOSTICS written = ROW_COUNT;
  -- Audit is last in lock order. A put that lost changed nothing and appends nothing; the row never carries the client
  -- secret.
  IF written = 1 THEN
    SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = p_ws;
    PERFORM app.audit_append(p_ws, org, 'user', caller::text,
      CASE WHEN removed = 1 THEN 'instance.app_replaced' ELSE 'instance.app_stored' END, 'instance_app', p_id::text,
      NULL, NULL, jsonb_build_object('provider_id', p_provider, 'instance_host', p_host));
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN written = 1;
END
$$;

REVOKE ALL ON FUNCTION app.instance_app_get(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instance_app_get(uuid, text, text) TO shoutory_app;
REVOKE ALL ON FUNCTION app.instance_app_put(uuid, uuid, text, text, text, integer, text, bytea, bytea, bytea, bytea,
  bytea, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instance_app_put(uuid, uuid, text, text, text, integer, text, bytea, bytea, bytea,
  bytea, bytea, bytea, text) TO shoutory_app;
RESET ROLE;
