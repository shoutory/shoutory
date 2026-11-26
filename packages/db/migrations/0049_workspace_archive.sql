-- Archive pauses a workspace: its rows stay, it still reads, and no change to its row, no admission of its due
-- targets and no write route reaches it until it is restored. A create may carry a client key that becomes the new
-- row's id, so a retried create returns the first row instead of making a second one.

GRANT UPDATE (archived_at, avatar) ON app.workspaces TO shoutory_definer;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations', 'workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['workspace_archive', 'workspace_unarchive', 'workspace_avatar_set']);
  END LOOP;
END
$$;
CALL app.grant_purposes('organizations', 'UPDATE', ARRAY['workspace_archive', 'workspace_unarchive',
  'workspace_avatar_set']);
CALL app.grant_purposes('workspaces', 'UPDATE', ARRAY['workspace_archive', 'workspace_unarchive',
  'workspace_avatar_set']);
-- The avatar is read under a share lock, which passes the UPDATE policy, so a concurrent delete waits for it.
CALL app.grant_purposes('media_assets', 'SELECT', ARRAY['workspace_avatar_set']);
CALL app.grant_purposes('media_assets', 'UPDATE', ARRAY['workspace_avatar_set']);
CALL app.grant_purposes('organizations', 'SELECT', ARRAY['organization_create', 'my_workspaces']);
CALL app.grant_purposes('workspace_members', 'SELECT', ARRAY['workspace_create']);

-- No purpose check: restore is the only change that clears archived_at, and the app role holds no grant on that
-- column, so a session setting cannot open an archived row.
CREATE FUNCTION app.workspace_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'workspace_guard: workspace_archived' USING ERRCODE = 'SH409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workspaces_guard BEFORE UPDATE ON app.workspaces
  FOR EACH ROW EXECUTE FUNCTION app.workspace_guard();
REVOKE ALL ON FUNCTION app.workspace_guard() FROM PUBLIC;
ALTER FUNCTION app.workspace_guard() OWNER TO shoutory_definer;

-- A repeat is a no-op with no audit row. A workspace whose deletion is requested is not archived (SH409).
CREATE FUNCTION app.workspace_archive(workspace_id uuid, request_id text, ip_hmac bytea)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  cur record;
BEGIN
  PERFORM set_config('app.job_purpose', 'workspace_archive', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'workspace_archive: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM app.tenancy_enter('workspace_archive', workspace_archive.workspace_id, caller, 4);
  SELECT w.organization_id, w.archived_at, w.deletion_requested_at INTO cur FROM app.workspaces AS w
    WHERE w.id = workspace_archive.workspace_id;
  IF cur.deletion_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'workspace_archive: deletion_requested' USING ERRCODE = 'SH409';
  END IF;
  IF cur.archived_at IS NULL THEN
    UPDATE app.workspaces AS w SET archived_at = clock_timestamp() WHERE w.id = workspace_archive.workspace_id
      RETURNING w.archived_at INTO cur.archived_at;
    PERFORM app.audit_append(workspace_archive.workspace_id, cur.organization_id, 'user', caller::text,
      'workspace.archived', 'workspace', workspace_archive.workspace_id::text, workspace_archive.request_id,
      workspace_archive.ip_hmac, '{}');
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN cur.archived_at;
END
$$;

CREATE FUNCTION app.workspace_unarchive(workspace_id uuid, request_id text, ip_hmac bytea)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  cur record;
BEGIN
  PERFORM set_config('app.job_purpose', 'workspace_unarchive', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'workspace_unarchive: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM app.tenancy_enter('workspace_unarchive', workspace_unarchive.workspace_id, caller, 4);
  SELECT w.organization_id, w.archived_at INTO cur FROM app.workspaces AS w
    WHERE w.id = workspace_unarchive.workspace_id;
  IF cur.archived_at IS NOT NULL THEN
    UPDATE app.workspaces AS w SET archived_at = NULL WHERE w.id = workspace_unarchive.workspace_id;
    PERFORM app.audit_append(workspace_unarchive.workspace_id, cur.organization_id, 'user', caller::text,
      'workspace.restored', 'workspace', workspace_unarchive.workspace_id::text, workspace_unarchive.request_id,
      workspace_unarchive.ip_hmac, '{}');
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NULL;
END
$$;

-- The avatar is a ready image of the same workspace; a missing, foreign or deleted one is refused as unknown (42501).
CREATE FUNCTION app.workspace_avatar_set(workspace_id uuid, media_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  asset record;
BEGIN
  PERFORM set_config('app.job_purpose', 'workspace_avatar_set', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'workspace_avatar_set: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM app.tenancy_enter('workspace_avatar_set', workspace_avatar_set.workspace_id, caller, 4);
  IF workspace_avatar_set.media_id IS NOT NULL THEN
    SELECT a.mime, a.state INTO asset FROM app.media_assets AS a
      WHERE a.workspace_id = workspace_avatar_set.workspace_id AND a.id = workspace_avatar_set.media_id FOR SHARE;
    IF NOT FOUND OR asset.state = 'deleted' THEN
      RAISE EXCEPTION 'workspace_avatar_set: refused' USING ERRCODE = '42501';
    END IF;
    IF asset.state <> 'ready' OR asset.mime NOT LIKE 'image/%' THEN
      RAISE EXCEPTION 'workspace_avatar_set: media_unavailable' USING ERRCODE = 'SH422';
    END IF;
  END IF;
  UPDATE app.workspaces AS w SET avatar = workspace_avatar_set.media_id WHERE w.id = workspace_avatar_set.workspace_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.workspace_archive(uuid, text, bytea), app.workspace_unarchive(uuid, text, bytea),
  app.workspace_avatar_set(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspace_archive(uuid, text, bytea), app.workspace_unarchive(uuid, text, bytea),
  app.workspace_avatar_set(uuid, uuid) TO shoutory_app;
ALTER FUNCTION app.workspace_archive(uuid, text, bytea) OWNER TO shoutory_definer;
ALTER FUNCTION app.workspace_unarchive(uuid, text, bytea) OWNER TO shoutory_definer;
ALTER FUNCTION app.workspace_avatar_set(uuid, uuid) OWNER TO shoutory_definer;

-- The definer owns the old functions and the migration owner does not inherit its rights.
SET ROLE shoutory_definer;
DROP FUNCTION app.organization_create(text, text, text, bytea, text);
DROP FUNCTION app.workspace_create(uuid, text, text, text, text, bytea, text);
DROP FUNCTION app.my_workspaces(integer, uuid);
RESET ROLE;

-- A key is a UUIDv7 (22023 otherwise) and becomes the new id; without one a fresh id is made. A key already used by
-- the same Owner for the same name and type returns that organization; any other use is SH422 and names nothing.
-- The bucket is taken after the insert, so a retry, even one racing the first call, spends no token.
CREATE FUNCTION app.organization_create(
  name text, type text, request_id text, ip_hmac bytea, bucket_key text, key uuid)
RETURNS TABLE (id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  new_id uuid;
  owned integer;
  spent record;
  prev record;
BEGIN
  PERFORM set_config('app.job_purpose', 'organization_create', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'organization_create refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF organization_create.key IS NOT NULL AND uuid_extract_version(organization_create.key) IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'organization_create: the key is a UUIDv7' USING ERRCODE = '22023';
  END IF;
  new_id := coalesce(organization_create.key, uuidv7());
  LOOP
    SELECT o.name, o.type, EXISTS (SELECT 1 FROM app.organization_members AS m
        WHERE m.organization_id = o.id AND m.user_id = caller AND m.org_role = 'owner') AS mine
      INTO prev FROM app.organizations AS o WHERE o.id = new_id;
    IF FOUND THEN
      IF prev.name IS DISTINCT FROM organization_create.name OR prev.type IS DISTINCT FROM organization_create.type
         OR NOT prev.mine THEN
        RAISE EXCEPTION 'organization_create: idempotency_key_reused' USING ERRCODE = 'SH422';
      END IF;
      PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
      RETURN QUERY SELECT new_id, true;
      RETURN;
    END IF;
    BEGIN
      INSERT INTO app.organizations (id, name, slug, type)
        VALUES (new_id, organization_create.name, 'o-' || replace(new_id::text, '-', ''), organization_create.type);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- A twin with the same key committed first (the insert waited for it); the next pass reads it.
    END;
  END LOOP;
  -- Taken only by the call that inserts, so a twin that replays spends nothing.
  SELECT t.allowed, t.retry_after_seconds INTO spent
    FROM app.bucket_take(organization_create.bucket_key, 'tenant_create', 1) AS t;
  IF NOT spent.allowed THEN
    RAISE EXCEPTION 'organization_create: rate_limited' USING ERRCODE = 'SH429',
      DETAIL = format('retry after %s seconds', spent.retry_after_seconds);
  END IF;
  INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES (new_id, caller, 'owner');
  PERFORM app.audit_append(NULL, new_id, 'user', caller::text, 'organization.created', 'organization', new_id::text,
    organization_create.request_id, organization_create.ip_hmac, '{}');
  SELECT count(*) INTO owned FROM app.organization_members AS m WHERE m.user_id = caller AND m.org_role = 'owner';
  IF owned > 20 THEN
    RAISE EXCEPTION 'organization_create: at most 20 owned organizations' USING ERRCODE = '53400';
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN QUERY SELECT new_id, false;
END
$$;

-- The key works as in organization_create; the replay is read under the organization lock, so two creates with one
-- key make one row. The replay matches the organization, the name, the zone when given and the slug when the caller
-- fixed it (a derived slug may differ between tries); the caller must still be its Owner. A template is a workspace
-- of the same organization (42501 otherwise, as unknown): its colour, lateness tolerance and, with no zone given,
-- its zone are copied. Neither a zone nor a template is 22023.
CREATE FUNCTION app.workspace_create(
  organization_id uuid, name text, requested_slug text, tz text, request_id text, ip_hmac bytea, bucket_key text, key uuid,
  template uuid, slug_fixed boolean)
RETURNS TABLE (id uuid, slug text, colour text, default_tz text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  org constant uuid := workspace_create.organization_id;
  new_id uuid;
  owner_role uuid;
  spent record;
  prev record;
  tpl record;
BEGIN
  PERFORM set_config('app.job_purpose', 'workspace_create', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user'
     OR NOT EXISTS (SELECT 1 FROM app.organization_members AS m
                    WHERE m.organization_id = org AND m.user_id = caller AND m.org_role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'workspace_create refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF workspace_create.key IS NOT NULL AND uuid_extract_version(workspace_create.key) IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'workspace_create: the key is a UUIDv7' USING ERRCODE = '22023';
  END IF;
  IF workspace_create.tz IS NULL AND workspace_create.template IS NULL THEN
    RAISE EXCEPTION 'workspace_create: a time zone or a template is needed' USING ERRCODE = '22023';
  END IF;
  IF workspace_create.tz IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS z WHERE z.name = workspace_create.tz) THEN
    RAISE EXCEPTION 'workspace_create: unknown time zone' USING ERRCODE = '22023';
  END IF;
  new_id := coalesce(workspace_create.key, uuidv7());
  PERFORM 1 FROM app.organizations AS o WHERE o.id = org FOR NO KEY UPDATE;
  IF NOT EXISTS (SELECT 1 FROM app.organization_members AS m
                 WHERE m.organization_id = org AND m.user_id = caller AND m.org_role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'workspace_create refuses this caller' USING ERRCODE = '42501';
  END IF;
  SELECT w.organization_id AS org, w.name, w.slug, w.colour, w.default_tz,
      EXISTS (SELECT 1 FROM app.workspace_members AS m JOIN app.roles AS r ON r.id = m.role_id
              WHERE m.workspace_id = w.id AND m.user_id = caller AND m.status = 'active'
                AND r.workspace_id IS NULL AND r.key = 'owner') AS mine
    INTO prev FROM app.workspaces AS w WHERE w.id = new_id;
  IF FOUND THEN
    IF prev.org IS DISTINCT FROM org OR prev.name IS DISTINCT FROM workspace_create.name
       OR (workspace_create.tz IS NOT NULL AND prev.default_tz IS DISTINCT FROM workspace_create.tz)
       OR (workspace_create.slug_fixed AND prev.slug IS DISTINCT FROM workspace_create.requested_slug) OR NOT prev.mine THEN
      RAISE EXCEPTION 'workspace_create: idempotency_key_reused' USING ERRCODE = 'SH422';
    END IF;
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN QUERY SELECT new_id, prev.slug, prev.colour, prev.default_tz, true;
    RETURN;
  END IF;
  IF workspace_create.template IS NOT NULL THEN
    SELECT w.colour, w.default_tz, w.lateness_tolerance INTO tpl FROM app.workspaces AS w
      WHERE w.id = workspace_create.template AND w.organization_id = org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'workspace_create refuses this caller' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (SELECT count(*) FROM app.workspaces AS w WHERE w.organization_id = org) >= 100 THEN
    RAISE EXCEPTION 'workspace_create: at most 100 workspaces per organization' USING ERRCODE = '53400';
  END IF;
  SELECT t.allowed, t.retry_after_seconds INTO spent
    FROM app.bucket_take(workspace_create.bucket_key, 'tenant_create', 1) AS t;
  IF NOT spent.allowed THEN
    RAISE EXCEPTION 'workspace_create: rate_limited' USING ERRCODE = 'SH429',
      DETAIL = format('retry after %s seconds', spent.retry_after_seconds);
  END IF;
  SELECT r.id INTO owner_role FROM app.roles AS r WHERE r.workspace_id IS NULL AND r.key = 'owner';
  IF workspace_create.template IS NULL THEN
    INSERT INTO app.workspaces (id, organization_id, name, slug, default_tz)
      VALUES (new_id, org, workspace_create.name, workspace_create.requested_slug, workspace_create.tz);
  ELSE
    INSERT INTO app.workspaces (id, organization_id, name, slug, default_tz, colour, lateness_tolerance)
      VALUES (new_id, org, workspace_create.name, workspace_create.requested_slug,
              coalesce(workspace_create.tz, tpl.default_tz), tpl.colour, tpl.lateness_tolerance);
  END IF;
  INSERT INTO app.workspace_members (workspace_id, user_id, role_id) VALUES (new_id, caller, owner_role);
  PERFORM app.audit_append(new_id, org, 'user', caller::text, 'workspace.created', 'workspace', new_id::text,
    workspace_create.request_id, workspace_create.ip_hmac, '{}');
  RETURN QUERY SELECT w.id, w.slug, w.colour, w.default_tz, false FROM app.workspaces AS w WHERE w.id = new_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.organization_create(text, text, text, bytea, text, uuid),
  app.workspace_create(uuid, text, text, text, text, bytea, text, uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organization_create(text, text, text, bytea, text, uuid),
  app.workspace_create(uuid, text, text, text, text, bytea, text, uuid, uuid, boolean) TO shoutory_app;
ALTER FUNCTION app.organization_create(text, text, text, bytea, text, uuid) OWNER TO shoutory_definer;
ALTER FUNCTION app.workspace_create(uuid, text, text, text, text, bytea, text, uuid, uuid, boolean)
  OWNER TO shoutory_definer;

-- The organization type comes with each row, so a member who holds only a workspace role still learns it.
CREATE FUNCTION app.my_workspaces(lim integer, after uuid)
RETURNS TABLE (workspace_id uuid, organization_id uuid, name text, slug text, role_key text, archived_at timestamptz,
  avatar uuid, organization_type text)
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
    SELECT w.id, w.organization_id, w.name, w.slug, r.rkey, w.archived_at, w.avatar, o.type
    FROM unnest(ids, keys) AS r (wid, rkey)
    JOIN app.workspaces AS w ON w.id = r.wid
    JOIN app.organizations AS o ON o.id = w.organization_id
    WHERE my_workspaces.after IS NULL OR w.id > my_workspaces.after
    ORDER BY w.id
    LIMIT my_workspaces.lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;
REVOKE ALL ON FUNCTION app.my_workspaces(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_workspaces(integer, uuid) TO shoutory_app;
ALTER FUNCTION app.my_workspaces(integer, uuid) OWNER TO shoutory_definer;

-- An archived workspace's due targets wait: after a restore within the lateness tolerance they are admitted once,
-- past it they take the missed path. An operation admitted before the archive runs to its end.
SET ROLE shoutory_definer;
CREATE OR REPLACE FUNCTION app.admit_due_targets(p_limit integer, p_providers jsonb)
RETURNS TABLE (operation_id uuid, workspace_id uuid, queue text, state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
  st text;
  reason text;
  tolerance interval;
  org uuid;
  ch text;
  secs integer;
  digest text;
  new_op uuid;
  cname text;
  added boolean;
  late boolean;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'admit_due_targets', true);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR jsonb_typeof(p_providers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'admit_due_targets: the limit is 1 to 500 and the providers an object' USING ERRCODE = '22023';
  END IF;
  -- A bad lease is the caller's defect, so no target is read.
  IF EXISTS (SELECT 1 FROM jsonb_each(p_providers) AS e (provider, facts)
      WHERE NOT coalesce(jsonb_typeof(e.facts -> 'lease_seconds' -> 'publish') = 'number'
        AND (e.facts -> 'lease_seconds' ->> 'publish') ~ '^[1-9][0-9]{0,8}$', false)) THEN
    RAISE EXCEPTION 'admit_due_targets: the publish lease of every provider is a positive whole number of seconds'
      USING ERRCODE = '22023';
  END IF;
  -- Only the target row is locked (OF v). The workspace row is read, not locked; it is named first because the
  -- lock-order check counts every table of a locking statement and the workspace comes before the target.
  FOR r IN
    SELECT v.id AS variant_id, v.workspace_id AS ws, v.channel_id, v.due_at, v.frozen_version_id, c.provider_id,
        p.author_id, p.id AS post_id
      FROM app.workspaces AS w
      JOIN app.post_variants AS v ON v.workspace_id = w.id
      JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      WHERE w.archived_at IS NULL
        AND v.schedule_state = 'scheduled' AND v.due_at IS NOT NULL AND p.deleted_at IS NULL AND p.status <> 'archived'
        AND jsonb_exists(p_providers, c.provider_id)
        AND v.due_at <= clock_timestamp() + make_interval(secs => (p_providers -> c.provider_id ->> 'margin_seconds')::float8)
        AND (clock_timestamp() > v.due_at + w.lateness_tolerance OR NOT EXISTS (
          SELECT 1 FROM app.post_versions AS pv
            CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(pv.snapshot -> 'resolved' -> 'media') = 'object'
              THEN pv.snapshot -> 'resolved' -> 'media' ELSE '{}'::jsonb END) AS m (media_id)
            LEFT JOIN app.media_assets AS a ON a.workspace_id = v.workspace_id
              AND a.id = CASE WHEN m.media_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN m.media_id::uuid END
            WHERE pv.workspace_id = v.workspace_id AND pv.id = v.frozen_version_id AND a.state IS DISTINCT FROM 'ready'))
      ORDER BY v.due_at, v.id LIMIT p_limit FOR UPDATE OF v SKIP LOCKED
  LOOP
    added := false;
    BEGIN
      SELECT w.lateness_tolerance, w.organization_id INTO tolerance, org FROM app.workspaces AS w WHERE w.id = r.ws;
      late := clock_timestamp() > r.due_at + tolerance;
      IF late THEN
        PERFORM 1 FROM app.posts AS p WHERE p.workspace_id = r.ws AND p.id = r.post_id FOR NO KEY UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
          CONTINUE;
        END IF;
      END IF;
      SELECT c.connection_state INTO ch FROM app.channels AS c WHERE c.workspace_id = r.ws AND c.id = r.channel_id FOR SHARE;
      IF late THEN
        st := 'missed'; reason := NULL;
      ELSIF ch = 'connected' THEN
        st := 'pending'; reason := NULL;
      ELSIF ch = 'disabled' THEN
        st := 'paused'; reason := 'channel_disabled';
      ELSE
        st := 'blocked_reconnect'; reason := 'pending';
      END IF;
      secs := (p_providers -> r.provider_id -> 'lease_seconds' ->> 'publish')::integer;
      SELECT encode(pv.snapshot_hash, 'hex') INTO digest FROM app.post_versions AS pv
        WHERE pv.workspace_id = r.ws AND pv.id = r.frozen_version_id;
      new_op := app.operation_insert(r.ws, jsonb_strip_nulls(jsonb_build_object(
        'variant_id', r.variant_id, 'channel_id', r.channel_id, 'provider_id', r.provider_id,
        'queue', 'publish.' || r.provider_id, 'kind', 'publish', 'part_index', 0, 'state', st, 'reason_code', reason,
        'due_at', r.due_at, 'lateness_deadline', r.due_at + tolerance, 'next_attempt_at', r.due_at,
        'blocked_since', CASE WHEN st = 'blocked_reconnect' THEN clock_timestamp() END,
        'idempotency_marker', 'admit-' || uuidv7()::text, 'requested_by', r.author_id, 'lease_seconds', secs,
        'frozen_version_id', CASE WHEN digest IS NOT NULL THEN r.frozen_version_id END,
        'frozen_snapshot_hash', digest)), 'S');
      IF st <> 'missed' THEN
        PERFORM app.operation_media_lock(r.ws, CASE WHEN digest IS NOT NULL THEN r.frozen_version_id END, new_op);
        PERFORM app.operation_media_pin(r.ws, new_op, CASE WHEN digest IS NOT NULL THEN r.frozen_version_id END);
        INSERT INTO app.usage_reservations (workspace_id, organization_id, operation_id, key, amount)
          VALUES (r.ws, org, new_op, 'posts_per_month', 1);
        UPDATE app.post_variants AS v SET schedule_state = CASE WHEN st = 'blocked_reconnect' THEN 'held' ELSE 'in_progress' END
          WHERE v.workspace_id = r.ws AND v.id = r.variant_id;
      END IF;
      INSERT INTO app.outbox (workspace_id, type, payload)
        VALUES (r.ws, 'operation.admitted', jsonb_build_object('operation_id', new_op, 'state', st));
      added := true;
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'operations_target_key' THEN
          RAISE;
        END IF;
      WHEN SQLSTATE 'SH409' THEN
        NULL;
      WHEN SQLSTATE 'SH422' THEN
        NULL;
    END;
    IF added THEN
      operation_id := new_op; workspace_id := r.ws; queue := 'publish.' || r.provider_id; state := st;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
END
$$;

-- Every member, invitation and channel definer enters the workspace here, so an archived one refuses them all after the
-- rank checks (an outsider still learns nothing); only archive and restore pass.
CREATE OR REPLACE FUNCTION app.tenancy_enter(fname text, ws uuid, caller uuid, need integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  have integer := app.tenancy_rank(ws, caller);
BEGIN
  IF have = 0 THEN RAISE EXCEPTION '%: refused', fname USING ERRCODE = '42501'; END IF;
  PERFORM app.tenancy_lock(ws);
  have := app.tenancy_rank(ws, caller);
  IF have = 0 THEN RAISE EXCEPTION '%: refused', fname USING ERRCODE = '42501'; END IF;
  IF have < need THEN RAISE EXCEPTION '%: rank too low', fname USING ERRCODE = 'SH403'; END IF;
  IF fname NOT IN ('workspace_archive', 'workspace_unarchive')
     AND EXISTS (SELECT 1 FROM app.workspaces AS w WHERE w.id = ws AND w.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION '%: workspace_archived', fname USING ERRCODE = 'SH409';
  END IF;
  RETURN have;
END
$$;

-- Accepting joins the workspace, so an archived one refuses it too.
CREATE OR REPLACE FUNCTION app.invitation_accept(token_digest bytea, request_id text, ip_hmac bytea)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  inv record;
  me record;
  st record;
  reason text;
  consumed integer;
BEGIN
  PERFORM set_config('app.job_purpose', 'invitation_accept', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'invitation_accept: refused' USING ERRCODE = '42501';
  END IF;
  SELECT i.id, i.workspace_id AS ws, i.email, i.invited_by, ro.id AS role_id, ro.key, ro.workspace_id AS role_ws
    INTO inv FROM app.invitations AS i JOIN app.roles AS ro ON ro.id = i.role_id
    WHERE i.token_hash = invitation_accept.token_digest;
  IF inv.id IS NULL OR inv.key = 'owner' OR inv.role_ws IS NOT NULL
     OR (SELECT count(*) FROM app.invitations AS i WHERE i.token_hash = invitation_accept.token_digest) <> 1 THEN
    RAISE EXCEPTION 'invitation_accept: refused' USING ERRCODE = '42501';
  END IF;
  SELECT u.email, u.email_verified INTO me FROM auth."user" AS u WHERE u.id = caller;
  IF lower(me.email) IS DISTINCT FROM inv.email THEN
    RAISE EXCEPTION 'invitation_accept: email_mismatch' USING ERRCODE = 'SH403';
  ELSIF NOT me.email_verified THEN
    RAISE EXCEPTION 'invitation_accept: email_unverified' USING ERRCODE = 'SH403';
  END IF;
  PERFORM app.tenancy_lock(inv.ws);
  SELECT i.accepted_at, i.revoked_at, i.expires_at INTO st FROM app.invitations AS i WHERE i.id = inv.id;
  reason := CASE
    WHEN st.accepted_at IS NOT NULL THEN 'used'
    WHEN st.revoked_at IS NOT NULL THEN 'revoked'
    WHEN st.expires_at <= now() THEN 'expired'
    WHEN app.tenancy_rank(inv.ws, inv.invited_by) < greatest(4, app.role_weight(inv.key)) THEN 'revoked' END;
  IF reason IS NOT NULL THEN
    RAISE EXCEPTION 'invitation_accept: %', reason USING ERRCODE = 'SH410',
      DETAIL = format('expires %s; invited by %s', st.expires_at,
                      (SELECT u.name FROM auth."user" AS u WHERE u.id = inv.invited_by));
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspaces AS w WHERE w.id = inv.ws AND w.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'invitation_accept: workspace_archived' USING ERRCODE = 'SH409';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_members AS m WHERE m.workspace_id = inv.ws AND m.user_id = caller) THEN
    RAISE EXCEPTION 'invitation_accept: already_member' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.invitations AS i SET accepted_at = now(), accepted_by = caller
    WHERE i.id = inv.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now();
  GET DIAGNOSTICS consumed = ROW_COUNT;
  IF consumed <> 1 THEN RAISE EXCEPTION 'invitation_accept: used' USING ERRCODE = 'SH410'; END IF;
  INSERT INTO app.workspace_members (workspace_id, user_id, role_id) VALUES (inv.ws, caller, inv.role_id);
  PERFORM app.audit_append(inv.ws, (SELECT w.organization_id FROM app.workspaces AS w WHERE w.id = inv.ws), 'user',
    caller::text, 'invitation.accepted', 'invitation', inv.id::text, invitation_accept.request_id,
    invitation_accept.ip_hmac, jsonb_build_object('role', inv.key));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN inv.ws;
END
$$;

-- A connect started before the archive finishes refused, so no channel is made in an archived workspace.
CREATE OR REPLACE FUNCTION app.oauth_flow_take(
  state_digest bytea, want_provider text, want_host text, request_id text, ip_hmac bytea)
RETURNS TABLE (
  outcome text, flow_id uuid, workspace_id uuid, user_id uuid, channel_id uuid, instance_host text, request_uri text,
  format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea,
  wrapped_dek bytea)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  hit record;
  seen record;
  kind text;
  audit_ws uuid;
  audit_flow uuid;
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'user' OR caller IS NULL THEN
    RAISE EXCEPTION 'oauth_flow_take: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.job_purpose', 'oauth_flow_take', true);
  WITH spent AS (
    UPDATE app.oauth_flows AS f SET consumed_at = clock_timestamp()
      WHERE f.state_hash = oauth_flow_take.state_digest AND f.consumed_at IS NULL RETURNING f.*),
  counted AS (SELECT count(*)::integer AS n FROM spent)
  SELECT counted.n, s.* INTO hit FROM counted LEFT JOIN spent AS s ON true LIMIT 1;
  IF hit.n = 0 THEN
    SELECT count(*)::integer AS n, (array_agg(f.workspace_id))[1] AS ws, (array_agg(f.id))[1] AS flow INTO seen
      FROM app.oauth_flows AS f WHERE f.state_hash = oauth_flow_take.state_digest;
    kind := CASE WHEN seen.n = 0 THEN 'unknown_state' ELSE 'consumed' END;
    IF seen.n = 1 THEN audit_ws := seen.ws; audit_flow := seen.flow; END IF;
  ELSIF hit.n > 1 THEN
    kind := 'ambiguous';
  ELSE
    audit_ws := hit.workspace_id;
    audit_flow := hit.id;
    kind := CASE
      WHEN hit.expires_at <= clock_timestamp() THEN 'expired'
      WHEN hit.provider_id <> oauth_flow_take.want_provider THEN 'wrong_provider'
      WHEN hit.instance_host IS DISTINCT FROM oauth_flow_take.want_host THEN 'wrong_instance_host'
      WHEN hit.user_id <> caller THEN 'wrong_user'
      WHEN app.tenancy_rank(hit.workspace_id, caller) < 4 THEN 'not_admin'
      WHEN EXISTS (SELECT 1 FROM app.workspaces AS w WHERE w.id = hit.workspace_id AND w.archived_at IS NOT NULL)
        THEN 'workspace_archived'
      ELSE 'ok' END;
  END IF;
  IF kind = 'ok' THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN QUERY SELECT kind, hit.id, hit.workspace_id, hit.user_id, hit.channel_id, hit.instance_host,
      hit.request_uri, hit.format_version, hit.key_id, hit.iv, hit.ciphertext, hit.auth_tag, hit.wrap_iv, hit.wrap_tag,
      hit.wrapped_dek;
    RETURN;
  END IF;
  PERFORM app.audit_append(audit_ws, (SELECT w.organization_id FROM app.workspaces AS w WHERE w.id = audit_ws), 'user',
    caller::text, 'channel.connect_refused', 'oauth_flow', coalesce(audit_flow::text, 'unknown'),
    oauth_flow_take.request_id, oauth_flow_take.ip_hmac, jsonb_build_object('outcome', kind));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN QUERY SELECT kind, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::integer,
    NULL::text, NULL::bytea, NULL::bytea, NULL::bytea, NULL::bytea, NULL::bytea, NULL::bytea;
END
$$;
RESET ROLE;
