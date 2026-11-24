-- A FORCE row security table gives its owner no access without a policy, so the built-in roles are seeded before
-- the template is applied to their table. Every write except a workspace profile comes from a definer function.

CREATE TABLE app.organizations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  type text NOT NULL CHECK (type IN ('agency', 'team', 'personal')),
  region text NOT NULL DEFAULT 'default' CHECK (char_length(region) BETWEEN 1 AND 64),
  plan_ref text CHECK (char_length(plan_ref) <= 255),
  deletion_requested_at timestamptz,
  CONSTRAINT organizations_slug_key UNIQUE (slug)
);

CREATE TABLE app.organization_members (
  organization_id uuid NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth."user" (id),
  org_role text NOT NULL CHECK (org_role IN ('owner', 'admin', 'member', 'billing')),
  PRIMARY KEY (organization_id, user_id)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX organization_members_user_idx ON app.organization_members (user_id);

CREATE TABLE app.workspaces (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES app.organizations (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  colour text CHECK (colour ~ '^#[0-9a-f]{6}$'),
  avatar uuid,
  default_tz text NOT NULL DEFAULT 'UTC' CHECK (char_length(default_tz) BETWEEN 1 AND 64),
  lateness_tolerance interval NOT NULL DEFAULT '2 hours' CHECK (lateness_tolerance >= interval '0'),
  region text NOT NULL DEFAULT 'default' CHECK (char_length(region) BETWEEN 1 AND 64),
  deletion_requested_at timestamptz,
  archived_at timestamptz,
  CONSTRAINT workspaces_organization_slug_key UNIQUE (organization_id, slug)
);

-- workspace_id is NULL for a built-in role.
CREATE TABLE app.roles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid REFERENCES app.workspaces (id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  permissions text[] NOT NULL CHECK (cardinality(permissions) <= 64),
  CONSTRAINT roles_workspace_key_key UNIQUE NULLS NOT DISTINCT (workspace_id, key)
);

-- role_id is a single-column key on purpose: a built-in role has no workspace, so it could never match a key that
-- leads with workspace_id.
CREATE TABLE app.workspace_members (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth."user" (id),
  role_id uuid NOT NULL REFERENCES app.roles (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  CONSTRAINT workspace_members_workspace_user_key UNIQUE (workspace_id, user_id)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX workspace_members_user_idx ON app.workspace_members (user_id);

CREATE TABLE app.instance_settings (
  key text PRIMARY KEY CHECK (key IN ('signup_enabled')),
  value jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The same lists are in the permission matrix of the core package; a test compares them.
INSERT INTO app.roles (workspace_id, key, name, permissions) VALUES
  (NULL, 'owner', 'Owner', ARRAY[
    'posts.view', 'posts.edit', 'approval.decide', 'publish.override', 'publish.resolve', 'channels.view',
    'channels.manage', 'library.view', 'library.edit', 'inbox.view', 'inbox.act', 'analytics.view',
    'developers.manage', 'keys.auto_approve', 'settings.manage', 'workspace.danger']),
  (NULL, 'admin', 'Admin', ARRAY[
    'posts.view', 'posts.edit', 'approval.decide', 'publish.resolve', 'channels.view', 'channels.manage',
    'library.view', 'library.edit', 'inbox.view', 'inbox.act', 'analytics.view', 'developers.manage',
    'settings.manage']),
  (NULL, 'editor', 'Editor', ARRAY[
    'posts.view', 'posts.edit', 'channels.view', 'library.view', 'library.edit', 'inbox.view', 'inbox.act',
    'analytics.view']),
  (NULL, 'approver', 'Approver', ARRAY['posts.view', 'approval.decide', 'library.view', 'analytics.view']),
  (NULL, 'viewer', 'Viewer', ARRAY['posts.view', 'library.view', 'inbox.view', 'analytics.view']);

-- W_builtin: W, except that a built-in row (key column NULL) is readable while the read set is not empty, so an
-- empty, missing or forged context reads no built-in. A write needs the write workspace, which a NULL never equals.
-- O: an organization row, read when it belongs to the session's organization. There is no write policy.
CREATE OR REPLACE FUNCTION app.apply_rls_template(tbl regclass, template text, key_col text DEFAULT 'workspace_id')
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  read_set constant text := format('%I = ANY ((SELECT app.ws_ids())::uuid[])', key_col);
  write_set constant text := format('%I = (SELECT app.write_ws()) AND ', key_col) || read_set;
  builtin_set constant text := format('%I IS NULL AND cardinality((SELECT app.ws_ids())) > 0', key_col);
BEGIN
  IF template IS NULL OR template NOT IN ('W', 'W_builtin', 'O', 'U', 'I', 'D') THEN
    RAISE EXCEPTION 'unknown template %', template USING ERRCODE = '22023';
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  IF template = 'U' THEN
    EXECUTE format(
      'CREATE POLICY u_select ON %s FOR SELECT TO shoutory_app, shoutory_worker '
      || 'USING (%I = (SELECT app.principal_id()) AND (SELECT app.principal_kind()) = ''user'')',
      tbl, key_col);
  ELSIF template = 'O' THEN
    EXECUTE format(
      'CREATE POLICY o_select ON %s FOR SELECT TO shoutory_app, shoutory_worker USING (%I = (SELECT app.org()))',
      tbl, key_col);
  ELSIF template IN ('W', 'W_builtin') THEN
    EXECUTE format(
      'CREATE POLICY w_select ON %s FOR SELECT TO shoutory_app, shoutory_worker USING (%s)',
      tbl, CASE WHEN template = 'W_builtin' THEN format('(%s) OR (%s)', read_set, builtin_set) ELSE read_set END);
    EXECUTE format('CREATE POLICY w_insert ON %s FOR INSERT TO shoutory_app, shoutory_worker WITH CHECK (%s)', tbl, write_set);
    EXECUTE format(
      'CREATE POLICY w_update ON %s FOR UPDATE TO shoutory_app, shoutory_worker USING (%s) WITH CHECK (%s)',
      tbl, write_set, write_set);
    EXECUTE format('CREATE POLICY w_delete ON %s FOR DELETE TO shoutory_app, shoutory_worker USING (%s)', tbl, write_set);
  END IF;
  IF template IN ('W', 'W_builtin', 'O') THEN
    EXECUTE format(
      'CREATE POLICY portal_restrictive ON %s AS RESTRICTIVE FOR ALL TO shoutory_app, shoutory_worker '
      || 'USING ((SELECT app.principal_kind()) <> ''portal'')',
      tbl);
  END IF;
END
$$;

REVOKE ALL ON FUNCTION app.apply_rls_template(regclass, text, text) FROM PUBLIC;

SELECT app.apply_rls_template('app.organizations'::regclass, 'O', 'id');
SELECT app.apply_rls_template('app.organization_members'::regclass, 'O', 'organization_id');
SELECT app.apply_rls_template('app.workspaces'::regclass, 'W', 'id');
SELECT app.apply_rls_template('app.roles'::regclass, 'W_builtin');
SELECT app.apply_rls_template('app.workspace_members'::regclass, 'W');
SELECT app.apply_rls_template('app.instance_settings'::regclass, 'I');

-- The runtime role may change only the profile columns of a workspace, never its organization, region, deletion or
-- archive marks.
GRANT SELECT ON app.organizations, app.organization_members, app.workspaces, app.workspace_members, app.roles
  TO shoutory_app;
GRANT UPDATE (name, slug, colour, default_tz) ON app.workspaces TO shoutory_app;

ALTER TABLE app.user_profiles ADD CONSTRAINT user_profiles_last_workspace_id_fkey
  FOREIGN KEY (last_workspace_id) REFERENCES app.workspaces (id) ON DELETE SET NULL NOT VALID;
-- shoutory:accepted-lock tables are empty when this file runs
ALTER TABLE app.user_profiles VALIDATE CONSTRAINT user_profiles_last_workspace_id_fkey;
-- shoutory:accepted-lock table is empty when this file runs
CREATE INDEX user_profiles_last_workspace_idx ON app.user_profiles (last_workspace_id);

ALTER TABLE app.email_outbox ADD CONSTRAINT email_outbox_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES app.workspaces (id) NOT VALID;
-- shoutory:accepted-lock tables are empty when this file runs
ALTER TABLE app.email_outbox VALIDATE CONSTRAINT email_outbox_workspace_id_fkey;
-- shoutory:accepted-lock table is empty when this file runs
CREATE INDEX email_outbox_workspace_idx ON app.email_outbox (workspace_id) WHERE workspace_id IS NOT NULL;

-- The check runs at commit so one transaction may hand ownership over, and it reads the members through its own
-- purpose, so the answer never depends on who changed them. An organization that no longer exists passes.
CREATE FUNCTION app.organization_owner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  orgs constant uuid[] := CASE TG_OP
    WHEN 'DELETE' THEN ARRAY[OLD.organization_id]
    WHEN 'INSERT' THEN ARRAY[NEW.organization_id]
    ELSE ARRAY[OLD.organization_id, NEW.organization_id] END;
  orphan uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'organization_owner_guard', true);
  SELECT g.id INTO orphan FROM unnest(orgs) AS g (id)
    WHERE EXISTS (SELECT 1 FROM app.organizations AS o WHERE o.id = g.id)
      AND NOT EXISTS (SELECT 1 FROM app.organization_members AS m WHERE m.organization_id = g.id AND m.org_role = 'owner')
    LIMIT 1;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION 'organization % must keep an owner', orphan USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

GRANT SELECT ON app.organizations, app.organization_members TO shoutory_definer;
CREATE POLICY organization_owner_guard_select ON app.organizations FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'organization_owner_guard');
CREATE POLICY organization_owner_guard_select ON app.organization_members FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'organization_owner_guard');
-- Created while the migration owner still owns the function; a trigger needs no EXECUTE to fire.
CREATE CONSTRAINT TRIGGER organization_owner_guard
  AFTER INSERT OR UPDATE OR DELETE ON app.organization_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.organization_owner_guard();
REVOKE ALL ON FUNCTION app.organization_owner_guard() FROM PUBLIC;
ALTER FUNCTION app.organization_owner_guard() OWNER TO shoutory_definer;

-- The caller is the signed-in user of the session context, never an argument, and must be an instance admin.
GRANT SELECT, INSERT, UPDATE ON app.instance_settings TO shoutory_definer;
CREATE POLICY instance_setting_set_all ON app.instance_settings FOR ALL TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'instance_setting_set')
  WITH CHECK ((SELECT app.job_purpose()) = 'instance_setting_set');
CREATE POLICY instance_setting_set_select ON app.instance_admins FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'instance_setting_set');

CREATE FUNCTION app.instance_setting_set(key text, value jsonb)
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
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.instance_setting_set(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instance_setting_set(text, jsonb) TO shoutory_app;
ALTER FUNCTION app.instance_setting_set(text, jsonb) OWNER TO shoutory_definer;
