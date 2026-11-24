-- A new function grants EXECUTE to PUBLIC unless told otherwise. Remove that default before the first function exists.
ALTER DEFAULT PRIVILEGES FOR ROLE shoutory_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- A missing, empty or malformed setting answers NULL (an empty array for the workspace list), never an error and
-- never a wider value.
CREATE FUNCTION app.ws_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN v ~ '^\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*)?\}$'
      AND length(v) - length(replace(v, ',', '')) < 500
    THEN v::uuid[]
    ELSE ARRAY[]::uuid[]
  END
  FROM (SELECT current_setting('app.workspace_ids', true) AS v) AS setting
$$;

CREATE FUNCTION app.write_ws() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v::uuid END
  FROM (SELECT current_setting('app.write_workspace_id', true) AS v) AS setting
$$;

CREATE FUNCTION app.org() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v::uuid END
  FROM (SELECT current_setting('app.organization_id', true) AS v) AS setting
$$;

CREATE FUNCTION app.principal_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v::uuid END
  FROM (SELECT current_setting('app.principal_id', true) AS v) AS setting
$$;

CREATE FUNCTION app.portal_grant_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v::uuid END
  FROM (SELECT current_setting('app.portal_grant_id', true) AS v) AS setting
$$;

CREATE FUNCTION app.principal_kind() RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN v IN ('user', 'service', 'job', 'portal') THEN v END
  FROM (SELECT current_setting('app.principal_kind', true) AS v) AS setting
$$;

CREATE FUNCTION app.service_kind() RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN v IN ('api_key', 'oauth_client', 'agent_runner') THEN v END
  FROM (SELECT current_setting('app.service_kind', true) AS v) AS setting
$$;

CREATE FUNCTION app.job_purpose() RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NULLIF(current_setting('app.job_purpose', true), '')
$$;

-- Policies run the helpers as the querying role, so only the roles that run policies and the definer role may execute them.
REVOKE ALL ON FUNCTION app.ws_ids(), app.write_ws(), app.org(), app.principal_id(), app.portal_grant_id(),
  app.principal_kind(), app.service_kind(), app.job_purpose() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ws_ids(), app.write_ws(), app.org(), app.principal_id(), app.portal_grant_id(),
  app.principal_kind(), app.service_kind(), app.job_purpose()
  TO shoutory_app, shoutory_worker, shoutory_definer;

-- A migration tool, so only the owner may run it. The table name comes from the regclass (already quoted) and the
-- key column is quoted as an identifier, so neither can inject SQL.
--
-- W: a session reads the workspaces in its read set and writes only its one write workspace, which must also be
-- in the read set. A portal principal is refused everything by a restrictive policy.
CREATE FUNCTION app.apply_rls_template(tbl regclass, template text, key_col text DEFAULT 'workspace_id')
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  read_set constant text := format('%I = ANY ((SELECT app.ws_ids())::uuid[])', key_col);
  write_set constant text := format('%I = (SELECT app.write_ws()) AND ', key_col) || read_set;
BEGIN
  IF template IS DISTINCT FROM 'W' THEN
    RAISE EXCEPTION 'unknown template %', template USING ERRCODE = '22023';
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY w_select ON %s FOR SELECT TO shoutory_app, shoutory_worker USING (%s)', tbl, read_set);
  EXECUTE format('CREATE POLICY w_insert ON %s FOR INSERT TO shoutory_app, shoutory_worker WITH CHECK (%s)', tbl, write_set);
  EXECUTE format(
    'CREATE POLICY w_update ON %s FOR UPDATE TO shoutory_app, shoutory_worker USING (%s) WITH CHECK (%s)',
    tbl, write_set, write_set);
  EXECUTE format('CREATE POLICY w_delete ON %s FOR DELETE TO shoutory_app, shoutory_worker USING (%s)', tbl, write_set);
  EXECUTE format(
    'CREATE POLICY portal_restrictive ON %s AS RESTRICTIVE FOR ALL TO shoutory_app, shoutory_worker '
    || 'USING ((SELECT app.principal_kind()) <> ''portal'')',
    tbl);
END
$$;

REVOKE ALL ON FUNCTION app.apply_rls_template(regclass, text, text) FROM PUBLIC;
