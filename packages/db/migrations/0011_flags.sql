-- Both tables are reached only through definers: no runtime role holds a privilege on them. An override is read
-- only inside the caller's own scope and can only be written while its flag is live; deleting a flag cascades.
CREATE TABLE app.feature_flags (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_-]*$' AND char_length(key) <= 64),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  owner text NOT NULL CHECK (char_length(owner) BETWEEN 1 AND 128),
  remove_by date NOT NULL,
  default_on boolean NOT NULL DEFAULT false
);
SELECT app.apply_rls_template('app.feature_flags'::regclass, 'I');

CREATE TABLE app.feature_flag_overrides (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  flag_key text NOT NULL REFERENCES app.feature_flags (key) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('instance', 'organization', 'workspace')),
  scope_id uuid,
  "on" boolean NOT NULL,
  CONSTRAINT feature_flag_overrides_scope_key UNIQUE NULLS NOT DISTINCT (flag_key, scope, scope_id),
  CONSTRAINT feature_flag_overrides_scope_id_check CHECK ((scope = 'instance') = (scope_id IS NULL))
);
SELECT app.apply_rls_template('app.feature_flag_overrides'::regclass, 'I');

GRANT SELECT ON app.feature_flags TO shoutory_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.feature_flag_overrides TO shoutory_definer;
CREATE POLICY flags_read_select ON app.feature_flags FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'flags_read');
CREATE POLICY flag_override_set_select ON app.feature_flags FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'feature_flag_override_set');
CREATE POLICY flags_read_select ON app.feature_flag_overrides FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'flags_read');
CREATE POLICY flag_override_set_all ON app.feature_flag_overrides FOR ALL TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'feature_flag_override_set')
  WITH CHECK ((SELECT app.job_purpose()) = 'feature_flag_override_set');
CREATE POLICY flag_override_set_select ON app.instance_admins FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'feature_flag_override_set');
CREATE POLICY instance_admin_check_select ON app.instance_admins FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'instance_admin_check');

-- Callable without a signed-in user on purpose (the flag loader runs before sign-in); it never returns an override
-- outside the caller's own scope. A flag past its removal date is still listed, so the admin screen can show it.
CREATE FUNCTION app.flags_read()
RETURNS TABLE (
  flag_key text, description text, owner text, remove_by date, default_on boolean,
  scope text, scope_id uuid, override_on boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'flags_read', true);
  RETURN QUERY
    SELECT f.key, f.description, f.owner, f.remove_by, f.default_on, o.scope, o.scope_id, o."on"
    FROM app.feature_flags AS f
    LEFT JOIN app.feature_flag_overrides AS o ON o.flag_key = f.key AND (
      o.scope = 'instance'
      OR (o.scope = 'organization' AND o.scope_id = app.org())
      OR (o.scope = 'workspace' AND o.scope_id = ANY (app.ws_ids())))
    ORDER BY f.key, o.scope;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.flags_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.flags_read() TO shoutory_app, shoutory_worker;
ALTER FUNCTION app.flags_read() OWNER TO shoutory_definer;

CREATE FUNCTION app.instance_admin_check()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  is_admin boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'instance_admin_check', true);
  is_admin := caller IS NOT NULL AND app.principal_kind() IS NOT DISTINCT FROM 'user'
    AND EXISTS (SELECT 1 FROM app.instance_admins AS a WHERE a.user_id = caller);
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN is_admin;
END
$$;

REVOKE ALL ON FUNCTION app.instance_admin_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instance_admin_check() TO shoutory_app;
ALTER FUNCTION app.instance_admin_check() OWNER TO shoutory_definer;

-- A NULL value removes the override. The caller comes from the session context and must be an instance admin.
CREATE FUNCTION app.feature_flag_override_set(flag_key text, enabled boolean, request_id text, ip_hmac bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
BEGIN
  PERFORM set_config('app.job_purpose', 'feature_flag_override_set', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user'
     OR NOT EXISTS (SELECT 1 FROM app.instance_admins AS a WHERE a.user_id = caller) THEN
    RAISE EXCEPTION 'feature_flag_override_set refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.feature_flags AS f
    WHERE f.key = feature_flag_override_set.flag_key AND f.remove_by >= (now() AT TIME ZONE 'UTC')::date) THEN
    RAISE EXCEPTION 'feature_flag_override_set refuses an unknown or retired flag' USING ERRCODE = '22023';
  END IF;
  IF feature_flag_override_set.enabled IS NULL THEN
    DELETE FROM app.feature_flag_overrides AS o
      WHERE o.flag_key = feature_flag_override_set.flag_key AND o.scope = 'instance';
  ELSE
    INSERT INTO app.feature_flag_overrides (flag_key, scope, scope_id, "on")
      VALUES (feature_flag_override_set.flag_key, 'instance', NULL, feature_flag_override_set.enabled)
      ON CONFLICT ON CONSTRAINT feature_flag_overrides_scope_key DO UPDATE SET "on" = EXCLUDED."on";
  END IF;
  PERFORM app.audit_append(NULL, NULL, 'user', caller::text, 'flag.override_set', 'feature_flag',
    feature_flag_override_set.flag_key, feature_flag_override_set.request_id, feature_flag_override_set.ip_hmac,
    jsonb_build_object('on', feature_flag_override_set.enabled));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.feature_flag_override_set(text, boolean, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.feature_flag_override_set(text, boolean, text, bytea) TO shoutory_app;
ALTER FUNCTION app.feature_flag_override_set(text, boolean, text, bytea) OWNER TO shoutory_definer;

DROP FUNCTION app.instance_setting_set(text, jsonb);

CREATE FUNCTION app.instance_setting_set(key text, value jsonb, request_id text, ip_hmac bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
BEGIN
  PERFORM set_config('app.job_purpose', 'instance_setting_set', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user'
     OR NOT EXISTS (SELECT 1 FROM app.instance_admins AS a WHERE a.user_id = caller) THEN
    RAISE EXCEPTION 'instance_setting_set refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF instance_setting_set.key IS DISTINCT FROM 'signup_enabled'
     OR jsonb_typeof(instance_setting_set.value) IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'instance_setting_set refuses this key or value' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.instance_settings (key, value, updated_by)
    VALUES (instance_setting_set.key, instance_setting_set.value, caller)
    ON CONFLICT ON CONSTRAINT instance_settings_pkey
    DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp();
  PERFORM app.audit_append(NULL, NULL, 'user', caller::text, 'instance.setting_set', 'instance_setting',
    instance_setting_set.key, instance_setting_set.request_id, instance_setting_set.ip_hmac,
    jsonb_build_object('value', instance_setting_set.value));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.instance_setting_set(text, jsonb, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instance_setting_set(text, jsonb, text, bytea) TO shoutory_app;
ALTER FUNCTION app.instance_setting_set(text, jsonb, text, bytea) OWNER TO shoutory_definer;
