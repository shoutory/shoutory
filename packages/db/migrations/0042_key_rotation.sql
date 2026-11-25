-- A key-encryption key can be retired only when no sealed row uses it. The listing reads every sealed table, and the
-- reseal moves channel credentials and instance apps to the active key; a flow lives minutes and is only listed.
GRANT SELECT ON app.provider_apps TO shoutory_definer;
GRANT UPDATE (secret_ciphertext, secret_iv, secret_auth_tag, secret_wrap_iv, secret_wrap_tag, secret_wrapped_dek,
  secret_key_id, secret_format_version, secret_generation) ON app.provider_instance_apps TO shoutory_definer;
CALL app.grant_purposes('provider_apps', 'SELECT', ARRAY['sealed_key_ids']);
CALL app.grant_purposes('oauth_flows', 'SELECT', ARRAY['sealed_key_ids']);
CALL app.grant_purposes('provider_instance_apps', 'SELECT',
  ARRAY['sealed_key_ids', 'instance_apps_reseal_batch', 'instance_apps_reseal_write']);
CALL app.grant_purposes('provider_instance_apps', 'UPDATE', ARRAY['instance_apps_reseal_write']);
CALL app.grant_purposes('channel_credentials', 'SELECT',
  ARRAY['channel_credentials_reseal_batch', 'channel_credentials_reseal_write']);
-- The row lock of the write needs the UPDATE policy as well.
CALL app.grant_purposes('channel_credentials', 'UPDATE', ARRAY['channel_credentials_reseal_write']);
CALL app.grant_purposes('workspace_key_salts', 'SELECT', ARRAY['channel_credentials_reseal_batch']);

SET ROLE shoutory_definer;

CREATE OR REPLACE FUNCTION app.sealed_key_ids()
RETURNS TABLE (key_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'sealed_key_ids', true);
  RETURN QUERY
    SELECT e.link_key_id FROM app.email_outbox AS e WHERE e.link_ciphertext IS NOT NULL
    UNION
    SELECT k.key_id FROM app.channel_credentials AS k
    UNION
    SELECT f.key_id FROM app.oauth_flows AS f
    UNION
    SELECT a.secret_key_id FROM app.provider_instance_apps AS a
    UNION
    SELECT p.secret_key_id FROM app.provider_apps AS p;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Rows of every state, with the salt of their own workspace; a row whose workspace has no salt comes with none and
-- cannot be opened, so the reseal counts it as skipped.
CREATE FUNCTION app.channel_credentials_reseal_batch(lim integer, active_key_id text, after_id uuid)
RETURNS TABLE (
  id uuid, workspace_id uuid, channel_id uuid, kind text, generation integer, format_version integer, key_id text,
  iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea, salt bytea)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF lim IS NULL OR lim NOT BETWEEN 1 AND 500 OR channel_credentials_reseal_batch.active_key_id IS NULL THEN
    RAISE EXCEPTION 'channel_credentials_reseal_batch refuses this limit or key id' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'channel_credentials_reseal_batch', true);
  RETURN QUERY
    SELECT k.id, k.workspace_id, k.channel_id, k.kind, k.generation, k.format_version, k.key_id, k.iv, k.ciphertext,
        k.auth_tag, k.wrap_iv, k.wrap_tag, k.wrapped_dek, s.salt
      FROM app.channel_credentials AS k
      LEFT JOIN app.workspace_key_salts AS s ON s.workspace_id = k.workspace_id
      WHERE k.key_id <> channel_credentials_reseal_batch.active_key_id AND (after_id IS NULL OR k.id > after_id)
      ORDER BY k.id LIMIT lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- A row under a live refresh lease, one whose last refresh has an unknown outcome (a refresher past its lease may still
-- store a rotated token), or one whose generation moved since the batch read it, is left alone: the refresher compares
-- the generation when it stores the new token, so a reseal under it would lose that token. The channel and the row's
-- state are never touched.
CREATE FUNCTION app.channel_credentials_reseal_write(
  p_id uuid, p_generation integer, p_ciphertext bytea, p_iv bytea, p_auth_tag bytea, p_wrap_iv bytea,
  p_wrap_tag bytea, p_wrapped_dek bytea, p_key_id text, p_format_version integer)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  cur record;
BEGIN
  PERFORM set_config('app.job_purpose', 'channel_credentials_reseal_write', true);
  SELECT k.generation, k.refreshing_until, k.refresh_attempt_outcome INTO cur
    FROM app.channel_credentials AS k WHERE k.id = p_id FOR UPDATE;
  IF NOT FOUND OR cur.generation <> p_generation OR cur.refreshing_until > clock_timestamp()
      OR cur.refresh_attempt_outcome IS NOT DISTINCT FROM 'unknown' THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN 'busy';
  END IF;
  UPDATE app.channel_credentials AS k SET ciphertext = p_ciphertext, iv = p_iv, auth_tag = p_auth_tag,
      wrap_iv = p_wrap_iv, wrap_tag = p_wrap_tag, wrapped_dek = p_wrapped_dek, key_id = p_key_id,
      format_version = p_format_version, generation = p_generation + 1
    WHERE k.id = p_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN 'resealed';
END
$$;

CREATE FUNCTION app.instance_apps_reseal_batch(lim integer, active_key_id text, after_id uuid)
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
  IF lim IS NULL OR lim NOT BETWEEN 1 AND 500 OR instance_apps_reseal_batch.active_key_id IS NULL THEN
    RAISE EXCEPTION 'instance_apps_reseal_batch refuses this limit or key id' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'instance_apps_reseal_batch', true);
  RETURN QUERY
    SELECT a.id, a.secret_generation, a.secret_format_version, a.secret_key_id, a.secret_iv, a.secret_ciphertext,
        a.secret_auth_tag, a.secret_wrap_iv, a.secret_wrap_tag, a.secret_wrapped_dek
      FROM app.provider_instance_apps AS a
      WHERE a.secret_key_id <> instance_apps_reseal_batch.active_key_id AND (after_id IS NULL OR a.id > after_id)
      ORDER BY a.id LIMIT lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Compare-and-set on the generation: false means another writer replaced or resealed the app first.
CREATE FUNCTION app.instance_apps_reseal_write(
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
  PERFORM set_config('app.job_purpose', 'instance_apps_reseal_write', true);
  UPDATE app.provider_instance_apps AS a SET secret_ciphertext = p_ciphertext, secret_iv = p_iv,
      secret_auth_tag = p_auth_tag, secret_wrap_iv = p_wrap_iv, secret_wrap_tag = p_wrap_tag,
      secret_wrapped_dek = p_wrapped_dek, secret_key_id = p_key_id, secret_format_version = p_format_version,
      secret_generation = p_generation + 1
    WHERE a.id = p_id AND a.secret_generation = p_generation;
  GET DIAGNOSTICS written = ROW_COUNT;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN written = 1;
END
$$;

-- The generation is part of what the secret is bound to, so the reader needs it.
DROP FUNCTION app.instance_app_get(uuid, text, text);
CREATE FUNCTION app.instance_app_get(p_ws uuid, p_provider text, p_host text)
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
      WHERE a.provider_id = p_provider AND a.instance_host = p_host;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.instance_app_get(uuid, text, text),
  app.channel_credentials_reseal_batch(integer, text, uuid),
  app.channel_credentials_reseal_write(uuid, integer, bytea, bytea, bytea, bytea, bytea, bytea, text, integer),
  app.instance_apps_reseal_batch(integer, text, uuid),
  app.instance_apps_reseal_write(uuid, integer, bytea, bytea, bytea, bytea, bytea, bytea, text, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instance_app_get(uuid, text, text) TO shoutory_app;
GRANT EXECUTE ON FUNCTION app.channel_credentials_reseal_batch(integer, text, uuid),
  app.channel_credentials_reseal_write(uuid, integer, bytea, bytea, bytea, bytea, bytea, bytea, text, integer),
  app.instance_apps_reseal_batch(integer, text, uuid),
  app.instance_apps_reseal_write(uuid, integer, bytea, bytea, bytea, bytea, bytea, bytea, text, integer)
  TO shoutory_worker;
RESET ROLE;
