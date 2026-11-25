-- An app registered on an instance is good only for the scopes it was registered with: a token asked for more is refused
-- (invalid_scope). So a stored app is keyed by its scope set, the sorted space-joined scopes of the provider's manifest,
-- and a row stored before the key existed (no scope set) is never read again; the purge below removes it.
-- shoutory:accepted-lock the app table holds one row per instance and scope set; the lock is held for this file only
ALTER TABLE app.provider_instance_apps
  ADD COLUMN scopes text CHECK (char_length(scopes) BETWEEN 1 AND 1024),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
-- shoutory:accepted-lock the app table holds one row per instance and scope set; the lock is held for this file only
ALTER TABLE app.provider_instance_apps DROP CONSTRAINT provider_instance_apps_host_key;
-- shoutory:accepted-lock the app table holds one row per instance and scope set; the lock is held for this file only
CREATE UNIQUE INDEX provider_instance_apps_scope_key ON app.provider_instance_apps (provider_id, instance_host, scopes);

-- A row with no scope set is never read, so it goes a day after it was stored. Any other app no pending flow and no
-- channel of its provider and host names is unused a day after it was stored. A channel keeps the apps of its host, so
-- a later revoke on disconnect still finds one. The remote registration on the instance stays: the provider offers no
-- way to delete it.
CREATE POLICY retention_seed_insert ON app.retention_classes FOR INSERT TO shoutory_owner WITH CHECK (true);
INSERT INTO app.retention_classes (class, table_name, kind, event_column, retain, partition_unit) VALUES
  ('app.provider_instance_apps', 'app.provider_instance_apps', 'window', 'CASE WHEN scopes IS NULL THEN created_at WHEN
    NOT EXISTS (SELECT 1 FROM app.oauth_flows AS f WHERE f.provider_id = provider_instance_apps.provider_id
      AND f.instance_host = provider_instance_apps.instance_host)
    AND NOT EXISTS (SELECT 1 FROM app.channels AS c WHERE c.provider_id = provider_instance_apps.provider_id
      AND c.instance_host = provider_instance_apps.instance_host)
    THEN created_at END', interval '1 day', NULL);
DROP POLICY retention_seed_insert ON app.retention_classes;
CALL app.grant_purposes('provider_instance_apps', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('provider_instance_apps', 'DELETE', ARRAY['purge_expired']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['purge_expired']);

SET ROLE shoutory_definer;
DROP FUNCTION app.instance_app_get(uuid, text, text);
CREATE FUNCTION app.instance_app_get(p_ws uuid, p_provider text, p_host text, p_scopes text)
RETURNS TABLE (
  id uuid, client_id text, format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea,
  wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea, generation integer)
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
        a.secret_auth_tag, a.secret_wrap_iv, a.secret_wrap_tag, a.secret_wrapped_dek, a.secret_generation
      FROM app.provider_instance_apps AS a
      WHERE a.provider_id = p_provider AND a.instance_host = p_host AND a.scopes = p_scopes;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

DROP FUNCTION app.instance_app_put(uuid, uuid, text, text, text, integer, text, bytea, bytea, bytea, bytea, bytea,
  bytea, text);
CREATE FUNCTION app.instance_app_put(
  p_id uuid, p_ws uuid, p_provider text, p_host text, p_scopes text, p_client_id text, format_version integer,
  key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea,
  p_replaces text)
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
  IF p_scopes IS NULL THEN
    RAISE EXCEPTION 'instance_app_put needs a scope set' USING ERRCODE = '22023';
  END IF;
  IF p_replaces IS NOT NULL THEN
    DELETE FROM app.provider_instance_apps AS a
      WHERE a.provider_id = p_provider AND a.instance_host = p_host AND a.scopes = p_scopes
        AND a.client_id = p_replaces;
    GET DIAGNOSTICS removed = ROW_COUNT;
  END IF;
  INSERT INTO app.provider_instance_apps (id, provider_id, instance_host, scopes, client_id, secret_ciphertext,
      secret_iv, secret_auth_tag, secret_wrap_iv, secret_wrap_tag, secret_wrapped_dek, secret_key_id,
      secret_format_version, secret_generation)
    VALUES (p_id, p_provider, p_host, p_scopes, p_client_id, instance_app_put.ciphertext, instance_app_put.iv,
      instance_app_put.auth_tag, instance_app_put.wrap_iv, instance_app_put.wrap_tag, instance_app_put.wrapped_dek,
      instance_app_put.key_id, instance_app_put.format_version, 1)
    ON CONFLICT (provider_id, instance_host, scopes) DO NOTHING;
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

REVOKE ALL ON FUNCTION app.instance_app_get(uuid, text, text, text),
  app.instance_app_put(uuid, uuid, text, text, text, text, integer, text, bytea, bytea, bytea, bytea, bytea, bytea,
    text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instance_app_get(uuid, text, text, text),
  app.instance_app_put(uuid, uuid, text, text, text, text, integer, text, bytea, bytea, bytea, bytea, bytea, bytea,
    text)
  TO shoutory_app;
RESET ROLE;
