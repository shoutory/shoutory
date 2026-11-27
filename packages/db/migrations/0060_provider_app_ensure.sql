-- The one app of a provider that signs for the whole instance (its key is made on first use), kept in the table that
-- already holds provider apps. No runtime role reads the table: the definers below are the only way in.
GRANT INSERT ON app.provider_apps TO shoutory_definer;
GRANT UPDATE (secret_ciphertext, secret_iv, secret_auth_tag, secret_wrap_iv, secret_wrap_tag, secret_wrapped_dek,
  secret_key_id, secret_format_version, secret_generation) ON app.provider_apps TO shoutory_definer;
CALL app.grant_purposes('provider_apps', 'SELECT', ARRAY['provider_app_ensure', 'provider_apps_reseal_batch',
  'provider_apps_reseal_write']);
CALL app.grant_purposes('provider_apps', 'INSERT', ARRAY['provider_app_ensure']);
CALL app.grant_purposes('provider_apps', 'UPDATE', ARRAY['provider_apps_reseal_write']);
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['provider_app_ensure']);
  END LOOP;
END
$$;

SET ROLE shoutory_definer;

-- With a candidate it stores that app unless the provider already has one (the first writer wins, and the loser reads
-- the winner's row); with none it only reads. The secret is sealed under the row's own id by the caller.
CREATE FUNCTION app.provider_app_ensure(
  p_workspace_id uuid, p_id uuid, p_provider text, p_client_id text, p_redirect_uri text, p_format_version integer,
  p_key_id text,
  p_iv bytea, p_ciphertext bytea, p_auth_tag bytea, p_wrap_iv bytea, p_wrap_tag bytea, p_wrapped_dek bytea)
RETURNS TABLE (
  id uuid, client_id text, redirect_uri text, format_version integer, key_id text, iv bytea, ciphertext bytea,
  auth_tag bytea, wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea, generation integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  kind constant text := app.principal_kind();
BEGIN
  PERFORM set_config('app.job_purpose', 'provider_app_ensure', true);
  -- A job reads and makes the app for the instance; a person does so only as an Admin of the workspace they name.
  IF kind IS DISTINCT FROM 'job' AND (kind IS DISTINCT FROM 'user' OR app.principal_id() IS NULL
       OR p_workspace_id IS NULL OR app.tenancy_rank(p_workspace_id, app.principal_id()) < 4) THEN
    RAISE EXCEPTION 'provider_app_ensure: refused' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NOT NULL THEN
    INSERT INTO app.provider_apps (id, provider_id, environment, client_id, redirect_uri, secret_format_version,
        secret_key_id, secret_iv, secret_ciphertext, secret_auth_tag, secret_wrap_iv, secret_wrap_tag,
        secret_wrapped_dek, secret_generation)
      VALUES (p_id, p_provider, 'production', p_client_id, p_redirect_uri, p_format_version, p_key_id, p_iv,
        p_ciphertext, p_auth_tag, p_wrap_iv, p_wrap_tag, p_wrapped_dek, 1)
      ON CONFLICT (provider_id, environment) WHERE active DO NOTHING;
  END IF;
  RETURN QUERY
    SELECT a.id, a.client_id, a.redirect_uri, a.secret_format_version, a.secret_key_id, a.secret_iv,
        a.secret_ciphertext, a.secret_auth_tag, a.secret_wrap_iv, a.secret_wrap_tag, a.secret_wrapped_dek,
        a.secret_generation
      FROM app.provider_apps AS a
      WHERE a.provider_id = p_provider AND a.environment = 'production' AND a.active;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

CREATE FUNCTION app.provider_apps_reseal_batch(lim integer, active_key_id text, after_id uuid)
RETURNS TABLE (
  id uuid, secret_generation integer, secret_format_version integer, secret_key_id text, secret_iv bytea,
  secret_ciphertext bytea, secret_auth_tag bytea, secret_wrap_iv bytea, secret_wrap_tag bytea,
  secret_wrapped_dek bytea)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF lim IS NULL OR lim NOT BETWEEN 1 AND 500 OR provider_apps_reseal_batch.active_key_id IS NULL THEN
    RAISE EXCEPTION 'provider_apps_reseal_batch refuses this limit or key id' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'provider_apps_reseal_batch', true);
  RETURN QUERY
    SELECT a.id, a.secret_generation, a.secret_format_version, a.secret_key_id, a.secret_iv, a.secret_ciphertext,
        a.secret_auth_tag, a.secret_wrap_iv, a.secret_wrap_tag, a.secret_wrapped_dek
      FROM app.provider_apps AS a
      WHERE a.secret_key_id <> provider_apps_reseal_batch.active_key_id AND (after_id IS NULL OR a.id > after_id)
      ORDER BY a.id LIMIT lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Compare-and-set on the generation: false means another writer resealed the app first.
CREATE FUNCTION app.provider_apps_reseal_write(
  p_id uuid, p_generation integer, p_ciphertext bytea, p_iv bytea, p_auth_tag bytea, p_wrap_iv bytea,
  p_wrap_tag bytea, p_wrapped_dek bytea, p_key_id text, p_format_version integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  written integer;
BEGIN
  PERFORM set_config('app.job_purpose', 'provider_apps_reseal_write', true);
  UPDATE app.provider_apps AS a SET secret_ciphertext = p_ciphertext, secret_iv = p_iv,
      secret_auth_tag = p_auth_tag, secret_wrap_iv = p_wrap_iv, secret_wrap_tag = p_wrap_tag,
      secret_wrapped_dek = p_wrapped_dek, secret_key_id = p_key_id, secret_format_version = p_format_version,
      secret_generation = p_generation + 1
    WHERE a.id = p_id AND a.secret_generation = p_generation;
  GET DIAGNOSTICS written = ROW_COUNT;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN written = 1;
END
$$;

REVOKE ALL ON FUNCTION
  app.provider_app_ensure(uuid, uuid, text, text, text, integer, text, bytea, bytea, bytea, bytea, bytea, bytea),
  app.provider_apps_reseal_batch(integer, text, uuid),
  app.provider_apps_reseal_write(uuid, integer, bytea, bytea, bytea, bytea, bytea, bytea, text, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.provider_app_ensure(uuid, uuid, text, text, text, integer, text, bytea, bytea, bytea, bytea, bytea, bytea)
  TO shoutory_app, shoutory_worker;
GRANT EXECUTE ON FUNCTION app.provider_apps_reseal_batch(integer, text, uuid),
  app.provider_apps_reseal_write(uuid, integer, bytea, bytea, bytea, bytea, bytea, bytea, text, integer)
  TO shoutory_worker;
RESET ROLE;
