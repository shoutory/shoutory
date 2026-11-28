-- One place makes an operation for a target: the scheduler's admission and the edit and delete writes of a person call
-- the same helper, so the media pin, the usage reservation, the lease, the marker, the requester and the event rows
-- cannot differ between them. One predicate says whether a frozen version waits for media; admission, the post read and
-- the notice scan all call it.
CALL app.grant_purposes('post_versions', 'SELECT', ARRAY['post_edit', 'post_delete']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['post_edit', 'post_delete']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['post_edit', 'post_delete']);
CALL app.grant_purposes('channels', 'UPDATE', ARRAY['post_edit', 'post_delete']);
CALL app.grant_purposes('operations', 'SELECT', ARRAY['post_edit', 'post_delete']);
CALL app.grant_purposes('post_variants', 'SELECT', ARRAY['post_edit', 'post_delete']);
CALL app.grant_purposes('post_variants', 'UPDATE', ARRAY['post_edit', 'post_delete']);
CALL app.grant_purposes('posts', 'SELECT', ARRAY['post_edit', 'post_delete']);
CALL app.grant_purposes('posts', 'UPDATE', ARRAY['post_edit', 'post_delete']);
CALL app.grant_purposes('post_media', 'SELECT', ARRAY['post_edit']);
CALL app.grant_purposes('post_media', 'INSERT', ARRAY['post_edit']);
CALL app.grant_purposes('post_media', 'DELETE', ARRAY['post_edit']);
CALL app.grant_purposes('post_versions', 'INSERT', ARRAY['post_edit']);
CALL app.grant_purposes('usage_reservations', 'INSERT', ARRAY['post_edit', 'post_delete']);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['post_edit', 'post_delete']);
  END LOOP;
END
$$;

SET ROLE shoutory_definer;

-- The outbox belongs to the definer, so its insert policies are created here.
CREATE POLICY post_edit_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'post_edit');
CREATE POLICY post_delete_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'post_delete');

CREATE FUNCTION app.media_held(p_ws uuid, p_version uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.post_versions AS pv
      CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(pv.snapshot -> 'resolved' -> 'media') = 'object'
        THEN pv.snapshot -> 'resolved' -> 'media' ELSE '{}'::jsonb END) AS m (media_id)
      LEFT JOIN app.media_assets AS a ON a.workspace_id = p_ws
        AND a.id = CASE WHEN m.media_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN m.media_id::uuid END
      WHERE pv.workspace_id = p_ws AND pv.id = p_version AND a.state IS DISTINCT FROM 'ready')
$$;

-- The channel is locked first, then the operation is inserted, its media pinned and its usage reserved, and the event
-- written; the caller, which holds the target, moves it. A caller that passes an audit action gets its audit row in the same
-- transaction. The version's hash is read here, so a caller names the version only.
CREATE FUNCTION app.ledger_admit_target(
  p_ws uuid, p_variant uuid, p_channel uuid, p_provider text, p_kind text, p_part integer, p_parent uuid,
  p_due timestamptz, p_missed boolean, p_requested_by uuid, p_lease integer, p_version uuid, p_marker text,
  p_pin boolean, p_reserve boolean, p_audit text, p_request text, p_ip bytea)
RETURNS TABLE (new_operation uuid, new_state text)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tolerance interval;
  org uuid;
  ch text;
  st text;
  op_reason text;
  digest bytea;
  frozen uuid;
BEGIN
  SELECT w.lateness_tolerance, w.organization_id INTO tolerance, org FROM app.workspaces AS w WHERE w.id = p_ws;
  SELECT c.connection_state INTO ch FROM app.channels AS c WHERE c.workspace_id = p_ws AND c.id = p_channel FOR SHARE;
  IF p_missed THEN
    st := 'missed';
  ELSIF ch = 'connected' THEN
    st := 'pending';
  ELSIF ch = 'disabled' THEN
    st := 'paused'; op_reason := 'channel_disabled';
  ELSE
    st := 'blocked_reconnect'; op_reason := 'pending';
  END IF;
  SELECT pv.snapshot_hash INTO digest FROM app.post_versions AS pv WHERE pv.workspace_id = p_ws AND pv.id = p_version;
  frozen := CASE WHEN digest IS NOT NULL THEN p_version END;
  new_operation := app.operation_insert(p_ws, jsonb_strip_nulls(jsonb_build_object(
    'variant_id', p_variant, 'channel_id', p_channel, 'provider_id', p_provider, 'queue', 'publish.' || p_provider,
    'kind', p_kind, 'part_index', p_part, 'depends_on_operation_id', p_parent, 'state', st, 'reason_code', op_reason,
    'due_at', p_due, 'lateness_deadline', p_due + tolerance, 'next_attempt_at', p_due,
    'blocked_since', CASE WHEN st = 'blocked_reconnect' THEN clock_timestamp() END,
    'idempotency_marker', p_marker, 'requested_by', p_requested_by, 'lease_seconds', p_lease,
    'frozen_version_id', frozen, 'frozen_snapshot_hash', encode(digest, 'hex'))), 'S');
  IF st <> 'missed' THEN
    IF p_pin THEN
      PERFORM app.operation_media_lock(p_ws, frozen, new_operation);
      PERFORM app.operation_media_pin(p_ws, new_operation, frozen);
    END IF;
    IF p_reserve THEN
      INSERT INTO app.usage_reservations (workspace_id, organization_id, operation_id, key, amount)
        VALUES (p_ws, org, new_operation, 'posts_per_month', 1);
    END IF;
  END IF;
  INSERT INTO app.outbox (workspace_id, type, payload)
    VALUES (p_ws, 'operation.admitted', jsonb_build_object('operation_id', new_operation, 'state', st));
  IF p_audit IS NOT NULL THEN
    PERFORM app.audit_insert(p_audit, 'operation', new_operation::text, p_request, p_ip,
      jsonb_build_object('kind', p_kind, 'variant_id', p_variant));
  END IF;
  new_state := st;
  RETURN NEXT;
END
$$;

-- Admission of the due targets: the media wait and the creation of the operation are the two functions above.
CREATE OR REPLACE FUNCTION app.admit_due_targets(p_limit integer, p_providers jsonb)
RETURNS TABLE (operation_id uuid, workspace_id uuid, queue text, state text, variant_id uuid, reason text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
  st text;
  tolerance interval;
  secs integer;
  new_op uuid;
  cname text;
  added boolean;
  late boolean;
  why text;
  chain_root uuid;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'admit_due_targets', true);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR jsonb_typeof(p_providers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'admit_due_targets: the limit is 1 to 500 and the providers an object' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(p_providers) AS e (provider, facts)
      WHERE NOT coalesce(jsonb_typeof(e.facts -> 'lease_seconds' -> 'publish') = 'number'
        AND (e.facts -> 'lease_seconds' ->> 'publish') ~ '^[1-9][0-9]{0,8}$', false)
        OR (jsonb_exists(e.facts -> 'lease_seconds', 'delete')
          AND NOT coalesce(jsonb_typeof(e.facts -> 'lease_seconds' -> 'delete') = 'number'
            AND (e.facts -> 'lease_seconds' ->> 'delete') ~ '^[1-9][0-9]{0,8}$', false))) THEN
    RAISE EXCEPTION 'admit_due_targets: the lease of every provider is a positive whole number of seconds'
      USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT v.id AS vid, v.workspace_id AS ws, v.channel_id, v.due_at, v.frozen_version_id, c.provider_id,
        p.author_id, p.id AS post_id
      FROM app.workspaces AS w
      JOIN app.post_variants AS v ON v.workspace_id = w.id
      JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      WHERE w.archived_at IS NULL
        AND v.schedule_state = 'scheduled' AND v.due_at IS NOT NULL AND p.deleted_at IS NULL AND p.status <> 'archived'
        AND (v.admit_skip_until IS NULL OR v.admit_skip_until <= clock_timestamp())
        AND jsonb_exists(p_providers, c.provider_id)
        AND v.due_at <= clock_timestamp() + make_interval(secs => (p_providers -> c.provider_id ->> 'margin_seconds')::float8)
        AND (clock_timestamp() > v.due_at + w.lateness_tolerance
          OR NOT app.media_held(v.workspace_id, v.frozen_version_id))
      ORDER BY v.due_at, v.id LIMIT p_limit FOR UPDATE OF v SKIP LOCKED
  LOOP
    added := false;
    why := NULL;
    BEGIN
      SELECT w.lateness_tolerance INTO tolerance FROM app.workspaces AS w WHERE w.id = r.ws;
      late := clock_timestamp() > r.due_at + tolerance;
      IF late THEN
        PERFORM 1 FROM app.posts AS p WHERE p.workspace_id = r.ws AND p.id = r.post_id FOR NO KEY UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
          CONTINUE;
        END IF;
      END IF;
      secs := (p_providers -> r.provider_id -> 'lease_seconds' ->> 'publish')::integer;
      SELECT f.new_operation, f.new_state INTO new_op, st FROM app.ledger_admit_target(r.ws, r.vid, r.channel_id,
        r.provider_id, 'publish', 0, NULL, r.due_at, late, r.author_id, secs, r.frozen_version_id,
        'admit-' || uuidv7()::text, true, true, NULL, NULL, NULL) AS f;
      IF st <> 'missed' THEN
        UPDATE app.post_variants AS v SET schedule_state = CASE WHEN st = 'blocked_reconnect' THEN 'held' ELSE 'in_progress' END
          WHERE v.workspace_id = r.ws AND v.id = r.vid;
      END IF;
      added := true;
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'operations_target_key' THEN
          RAISE;
        END IF;
        why := 'target_in_flight';
      WHEN SQLSTATE 'SH409' THEN
        why := 'guard_refused';
      WHEN SQLSTATE 'SH422' THEN
        NULL;
    END;
    IF added THEN
      operation_id := new_op; workspace_id := r.ws; queue := 'publish.' || r.provider_id; state := st;
      variant_id := r.vid; reason := NULL;
      RETURN NEXT;
    ELSIF why IS NOT NULL THEN
      UPDATE app.post_variants AS v SET admit_skip_until = clock_timestamp() + interval '5 minutes'
        WHERE v.workspace_id = r.ws AND v.id = r.vid;
      operation_id := NULL; workspace_id := r.ws; queue := NULL; state := 'refused'; variant_id := r.vid; reason := why;
      RETURN NEXT;
    END IF;
  END LOOP;
  FOR r IN
    SELECT v.id AS vid, v.workspace_id AS ws, v.channel_id, c.provider_id, prev.id AS prev_id,
        prev.part_index AS prev_part, prev.requested_by AS req, root.id AS root_id,
        root.frozen_version_id AS version_id, root.frozen_snapshot_hash AS hash, prev.lease_seconds AS lease,
        jsonb_exists(p_providers, c.provider_id) AS known
      FROM app.post_variants AS v
      JOIN app.workspaces AS w ON w.id = v.workspace_id
      JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      JOIN LATERAL (SELECT o.id, o.part_index, o.requested_by, o.lease_seconds FROM app.operations AS o
          WHERE o.workspace_id = v.workspace_id AND o.variant_id = v.id AND o.kind = 'publish' AND o.state = 'published'
          ORDER BY o.part_index DESC LIMIT 1) AS prev ON true
      JOIN app.operations AS root ON root.workspace_id = v.workspace_id AND root.variant_id = v.id
        AND root.kind = 'publish' AND root.part_index = 0 AND root.state = 'published'
      WHERE w.archived_at IS NULL AND v.schedule_state = 'in_progress' AND p.deleted_at IS NULL AND p.status <> 'archived'
        AND (v.admit_skip_until IS NULL OR v.admit_skip_until <= clock_timestamp())
        AND prev.part_index < jsonb_array_length(
          app.ledger_thread_parts(v.workspace_id, root.frozen_version_id, v.channel_id, v.locale))
        AND NOT EXISTS (SELECT 1 FROM app.operations AS n WHERE n.workspace_id = v.workspace_id AND n.variant_id = v.id
          AND n.kind = 'publish' AND n.part_index = prev.part_index + 1)
      ORDER BY v.id LIMIT p_limit FOR UPDATE OF v SKIP LOCKED
  LOOP
    added := false;
    why := NULL;
    BEGIN
      IF r.known THEN
        SELECT f.new_operation, f.new_state INTO new_op, st FROM app.ledger_insert_follow_up(r.ws, r.vid, r.channel_id,
          r.provider_id, 'publish.' || r.provider_id, 'publish', r.prev_part + 1, r.prev_id,
          'part-' || r.root_id || '-' || (r.prev_part + 1), r.req,
          (p_providers -> r.provider_id -> 'lease_seconds' ->> 'publish')::integer, r.version_id, r.hash, false) AS f;
        added := true;
      ELSE
        why := 'provider_unavailable';
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS NULL OR cname NOT IN ('operations_target_key', 'operations_marker_key') THEN
          RAISE;
        END IF;
      WHEN SQLSTATE 'SH409' THEN
        why := 'guard_refused';
    END;
    IF added THEN
      operation_id := new_op; workspace_id := r.ws; queue := 'publish.' || r.provider_id; state := st;
      variant_id := r.vid; reason := NULL;
      RETURN NEXT;
    ELSIF why IS NOT NULL THEN
      BEGIN
        PERFORM app.ledger_insert_follow_up(r.ws, r.vid, r.channel_id, r.provider_id, 'publish.' || r.provider_id,
          'publish', r.prev_part + 1, r.prev_id, 'part-' || r.root_id || '-' || (r.prev_part + 1), r.req, r.lease,
          r.version_id, r.hash, true);
      EXCEPTION WHEN SQLSTATE 'SH409' THEN
        UPDATE app.post_variants AS v SET admit_skip_until = clock_timestamp() + interval '5 minutes'
          WHERE v.workspace_id = r.ws AND v.id = r.vid;
      END;
      operation_id := NULL; workspace_id := r.ws; queue := NULL; state := 'refused'; variant_id := r.vid; reason := why;
      RETURN NEXT;
    END IF;
  END LOOP;
  FOR r IN
    SELECT d.id AS did, d.workspace_id AS ws, d.variant_id AS vid, d.channel_id, d.provider_id, d.queue AS dqueue,
        d.requested_by AS req, d.frozen_version_id AS version_id, d.frozen_snapshot_hash AS hash,
        d.lease_seconds AS dlease, nxt.part_index AS next_part, jsonb_exists(p_providers, d.provider_id) AS known
      FROM app.operations AS d
      JOIN app.post_variants AS v ON v.workspace_id = d.workspace_id AND v.id = d.variant_id
      JOIN app.workspaces AS w ON w.id = d.workspace_id
      JOIN LATERAL (SELECT max(o.part_index) AS part_index FROM app.operations AS o
          WHERE o.workspace_id = d.workspace_id AND o.variant_id = d.variant_id AND o.kind = 'publish'
            AND o.state = 'published' AND o.part_index < d.part_index) AS nxt ON nxt.part_index IS NOT NULL
      WHERE d.kind = 'delete' AND d.state = 'published' AND d.part_index > 0 AND v.presence = 'removal_pending'
        AND w.archived_at IS NULL AND (v.admit_skip_until IS NULL OR v.admit_skip_until <= clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM app.operations AS n WHERE n.workspace_id = d.workspace_id
          AND n.depends_on_operation_id = d.id)
      ORDER BY d.id LIMIT p_limit FOR UPDATE OF v SKIP LOCKED
  LOOP
    added := false;
    why := NULL;
    BEGIN
      WITH RECURSIVE chain (id, parent, depth) AS (
        SELECT o.id, o.depends_on_operation_id, 0 FROM app.operations AS o WHERE o.workspace_id = r.ws AND o.id = r.did
        UNION ALL
        SELECT o.id, o.depends_on_operation_id, c.depth + 1 FROM chain AS c
          JOIN app.operations AS o ON o.workspace_id = r.ws AND o.id = c.parent AND o.kind = 'delete')
      SELECT c.id INTO chain_root FROM chain AS c ORDER BY c.depth DESC LIMIT 1;
      IF r.known THEN
        SELECT f.new_operation, f.new_state INTO new_op, st FROM app.ledger_insert_follow_up(r.ws, r.vid, r.channel_id,
          r.provider_id, r.dqueue, 'delete', r.next_part, r.did, 'delete-' || chain_root || '-' || r.next_part, r.req,
          coalesce((p_providers -> r.provider_id -> 'lease_seconds' ->> 'delete')::integer, r.dlease), r.version_id,
          r.hash, false) AS f;
        added := true;
      ELSE
        why := 'provider_unavailable';
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS NULL OR cname NOT IN ('operations_target_key', 'operations_marker_key') THEN
          RAISE;
        END IF;
      WHEN SQLSTATE 'SH409' THEN
        why := 'guard_refused';
    END;
    IF added THEN
      operation_id := new_op; workspace_id := r.ws; queue := r.dqueue; state := st;
      variant_id := r.vid; reason := NULL;
      RETURN NEXT;
    ELSIF why IS NOT NULL THEN
      BEGIN
        PERFORM app.ledger_insert_follow_up(r.ws, r.vid, r.channel_id, r.provider_id, r.dqueue, 'delete', r.next_part,
          r.did, 'delete-' || chain_root || '-' || r.next_part, r.req, r.dlease, r.version_id, r.hash, true);
      EXCEPTION WHEN SQLSTATE 'SH409' THEN
        UPDATE app.post_variants AS v SET admit_skip_until = clock_timestamp() + interval '5 minutes'
          WHERE v.workspace_id = r.ws AND v.id = r.vid;
      END;
      operation_id := NULL; workspace_id := r.ws; queue := NULL; state := 'refused'; variant_id := r.vid; reason := why;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
END
$$;

REVOKE ALL ON FUNCTION app.media_held(uuid, uuid),
  app.ledger_admit_target(uuid, uuid, uuid, text, text, integer, uuid, timestamptz, boolean, uuid, integer, uuid, text,
    boolean, boolean, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_held(uuid, uuid) TO shoutory_app, shoutory_worker;
RESET ROLE;
