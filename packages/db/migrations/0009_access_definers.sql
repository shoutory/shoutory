-- Every function here serves a signed-in user: the caller is read from the session context, never from an argument,
-- and any other principal kind (or none) is refused with 42501. Each function sets its own purpose at entry and puts
-- the caller's purpose back at exit, and each table it touches has one policy for that purpose and command, so a
-- function cannot read or write a table it was not written for. The policies read no row column: the function does
-- the filtering. The definer role gets read and insert only on these tables.
GRANT SELECT ON app.workspaces, app.workspace_members, app.roles TO shoutory_definer;
GRANT INSERT ON app.organizations, app.organization_members, app.workspaces, app.workspace_members
  TO shoutory_definer;
-- Name and image only: the directory never exposes an address.
GRANT SELECT (name, image) ON auth."user" TO shoutory_definer;

CREATE POLICY resolve_workspace_access_select ON app.workspace_members FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'resolve_workspace_access');
CREATE POLICY resolve_workspace_access_select ON app.workspaces FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'resolve_workspace_access');
CREATE POLICY resolve_workspace_access_select ON app.roles FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'resolve_workspace_access');
CREATE POLICY resolve_workspace_access_select ON app.organization_members FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'resolve_workspace_access');
CREATE POLICY my_workspaces_select ON app.workspaces FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'my_workspaces');
CREATE POLICY my_organizations_select ON app.organization_members FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'my_organizations');
CREATE POLICY my_organizations_select ON app.organizations FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'my_organizations');
CREATE POLICY member_directory_select ON app.workspace_members FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'member_directory');
CREATE POLICY workspace_create_select ON app.organization_members FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'workspace_create');
CREATE POLICY workspace_create_select ON app.roles FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'workspace_create');
CREATE POLICY workspace_create_insert ON app.workspaces FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'workspace_create');
CREATE POLICY workspace_create_insert ON app.workspace_members FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'workspace_create');
CREATE POLICY organization_create_select ON app.organization_members FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'organization_create');
CREATE POLICY organization_create_insert ON app.organizations FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'organization_create');
CREATE POLICY organization_create_insert ON app.organization_members FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'organization_create');

-- Reaches a workspace through a stored active membership, or as an owner or admin of its organization (implicit
-- admin); the role is the higher of the two. A custom role ranks below viewer. More than 500 workspaces raise 54000
-- (the size of the context's workspace list): the answer is never cut short.
CREATE FUNCTION app.resolve_workspace_access()
RETURNS TABLE (workspace_id uuid, organization_id uuid, role_key text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  reached record;
  seen integer := 0;
BEGIN
  PERFORM set_config('app.job_purpose', 'resolve_workspace_access', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'resolve_workspace_access refuses this caller' USING ERRCODE = '42501';
  END IF;
  FOR reached IN
    SELECT c.wid, c.org, (array_agg(c.key ORDER BY c.weight DESC))[1] AS rkey
    FROM (
      SELECT m.workspace_id AS wid, w.organization_id AS org, ro.key,
             CASE ro.key WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'editor' THEN 3 WHEN 'approver' THEN 2
               WHEN 'viewer' THEN 1 ELSE 0 END AS weight
      FROM app.workspace_members AS m
      JOIN app.workspaces AS w ON w.id = m.workspace_id
      JOIN app.roles AS ro ON ro.id = m.role_id
      WHERE m.user_id = caller AND m.status = 'active'
      UNION ALL
      SELECT w.id, w.organization_id, 'admin', 4
      FROM app.organization_members AS om
      JOIN app.workspaces AS w ON w.organization_id = om.organization_id
      WHERE om.user_id = caller AND om.org_role IN ('owner', 'admin')
    ) AS c
    GROUP BY c.wid, c.org
    ORDER BY c.wid
    LIMIT 501
  LOOP
    seen := seen + 1;
    IF seen > 500 THEN
      RAISE EXCEPTION 'resolve_workspace_access: more than 500 reachable workspaces' USING ERRCODE = '54000';
    END IF;
    workspace_id := reached.wid;
    organization_id := reached.org;
    role_key := reached.rkey;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The reachable set is read first and whole, so the nested call has put this function's purpose back before the
-- rows are joined.
CREATE FUNCTION app.my_workspaces(lim integer, after uuid)
RETURNS TABLE (workspace_id uuid, organization_id uuid, name text, slug text, role_key text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  ids uuid[];
  keys text[];
BEGIN
  PERFORM set_config('app.job_purpose', 'my_workspaces', true);
  IF app.principal_id() IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'my_workspaces refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF my_workspaces.lim IS NULL OR my_workspaces.lim NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'my_workspaces: lim must be from 1 to 100' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(a.workspace_id), array_agg(a.role_key) INTO ids, keys FROM app.resolve_workspace_access() AS a;
  RETURN QUERY
    SELECT w.id, w.organization_id, w.name, w.slug, r.rkey
    FROM unnest(ids, keys) AS r (wid, rkey)
    JOIN app.workspaces AS w ON w.id = r.wid
    WHERE my_workspaces.after IS NULL OR w.id > my_workspaces.after
    ORDER BY w.id
    LIMIT my_workspaces.lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- An organization with no workspace is listed here, so a new owner can still find it.
CREATE FUNCTION app.my_organizations(lim integer, after uuid)
RETURNS TABLE (organization_id uuid, name text, slug text, type text, org_role text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
BEGIN
  PERFORM set_config('app.job_purpose', 'my_organizations', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'my_organizations refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF my_organizations.lim IS NULL OR my_organizations.lim NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'my_organizations: lim must be from 1 to 100' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT o.id, o.name, o.slug, o.type, m.org_role
    FROM app.organization_members AS m
    JOIN app.organizations AS o ON o.id = m.organization_id
    WHERE m.user_id = caller AND (my_organizations.after IS NULL OR o.id > my_organizations.after)
    ORDER BY o.id
    LIMIT my_organizations.lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- A workspace outside the caller's reach gives no rows, exactly like an empty one. Implicit organization admins hold
-- no membership row and are not listed.
CREATE FUNCTION app.member_directory(workspace_id uuid, lim integer, after uuid)
RETURNS TABLE (user_id uuid, name text, image text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  ids uuid[];
BEGIN
  PERFORM set_config('app.job_purpose', 'member_directory', true);
  IF app.principal_id() IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'member_directory refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF member_directory.lim IS NULL OR member_directory.lim NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'member_directory: lim must be from 1 to 100' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(a.workspace_id) INTO ids FROM app.resolve_workspace_access() AS a;
  IF member_directory.workspace_id = ANY (ids) THEN
    RETURN QUERY
      SELECT m.user_id, u.name, u.image
      FROM app.workspace_members AS m
      JOIN auth."user" AS u ON u.id = m.user_id
      WHERE m.workspace_id = member_directory.workspace_id AND m.status = 'active'
        AND (member_directory.after IS NULL OR m.user_id > member_directory.after)
      ORDER BY m.user_id
      LIMIT member_directory.lim;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The slug comes from the id, so it never collides and tells nothing. The count of owned organizations is read after
-- the audit write has taken the instance chain's head lock, which serialises every call: two calls at 19 cannot both
-- pass. Over 20 owned organizations the call raises 53400 and the whole transaction rolls back.
CREATE FUNCTION app.organization_create(name text, type text, request_id text, ip_hmac bytea)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  new_id constant uuid := uuidv7();
  owned integer;
BEGIN
  PERFORM set_config('app.job_purpose', 'organization_create', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'organization_create refuses this caller' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.organizations (id, name, slug, type)
    VALUES (new_id, organization_create.name, 'o-' || replace(new_id::text, '-', ''), organization_create.type);
  INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES (new_id, caller, 'owner');
  PERFORM app.audit_append(NULL, new_id, 'user', caller::text, 'organization.created', 'organization', new_id::text,
    organization_create.request_id, organization_create.ip_hmac, '{}');
  SELECT count(*) INTO owned FROM app.organization_members AS m WHERE m.user_id = caller AND m.org_role = 'owner';
  IF owned > 20 THEN
    RAISE EXCEPTION 'organization_create: at most 20 owned organizations' USING ERRCODE = '53400';
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;

-- A foreign and a missing organization give the same refusal. The slug is the caller's: a clash can only be inside
-- an organization the caller administers.
CREATE FUNCTION app.workspace_create(
  organization_id uuid, name text, slug text, tz text, request_id text, ip_hmac bytea)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  new_id constant uuid := uuidv7();
  owner_role uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'workspace_create', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user'
     OR NOT EXISTS (SELECT 1 FROM app.organization_members AS m
                    WHERE m.organization_id = workspace_create.organization_id AND m.user_id = caller
                      AND m.org_role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'workspace_create refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS z WHERE z.name = workspace_create.tz) THEN
    RAISE EXCEPTION 'workspace_create: unknown time zone' USING ERRCODE = '22023';
  END IF;
  SELECT r.id INTO owner_role FROM app.roles AS r WHERE r.workspace_id IS NULL AND r.key = 'owner';
  INSERT INTO app.workspaces (id, organization_id, name, slug, default_tz)
    VALUES (new_id, workspace_create.organization_id, workspace_create.name, workspace_create.slug,
            workspace_create.tz);
  INSERT INTO app.workspace_members (workspace_id, user_id, role_id) VALUES (new_id, caller, owner_role);
  PERFORM app.audit_append(new_id, workspace_create.organization_id, 'user', caller::text, 'workspace.created',
    'workspace', new_id::text, workspace_create.request_id, workspace_create.ip_hmac, '{}');
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;

REVOKE ALL ON FUNCTION app.resolve_workspace_access() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.my_workspaces(integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.my_organizations(integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.member_directory(uuid, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.organization_create(text, text, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.workspace_create(uuid, text, text, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_workspace_access() TO shoutory_app;
GRANT EXECUTE ON FUNCTION app.my_workspaces(integer, uuid) TO shoutory_app;
GRANT EXECUTE ON FUNCTION app.my_organizations(integer, uuid) TO shoutory_app;
GRANT EXECUTE ON FUNCTION app.member_directory(uuid, integer, uuid) TO shoutory_app;
GRANT EXECUTE ON FUNCTION app.organization_create(text, text, text, bytea) TO shoutory_app;
GRANT EXECUTE ON FUNCTION app.workspace_create(uuid, text, text, text, text, bytea) TO shoutory_app;
ALTER FUNCTION app.resolve_workspace_access() OWNER TO shoutory_definer;
ALTER FUNCTION app.my_workspaces(integer, uuid) OWNER TO shoutory_definer;
ALTER FUNCTION app.my_organizations(integer, uuid) OWNER TO shoutory_definer;
ALTER FUNCTION app.member_directory(uuid, integer, uuid) OWNER TO shoutory_definer;
ALTER FUNCTION app.organization_create(text, text, text, bytea) OWNER TO shoutory_definer;
ALTER FUNCTION app.workspace_create(uuid, text, text, text, text, bytea) OWNER TO shoutory_definer;
