-- A thread or a first comment publishes as a chain of parts: each part is inserted when the part before it is
-- published, and a thread delete is a chain of deletes from the last published part to the root. The variant stays in
-- progress while parts remain, and the post is partially published when a later part ended without publishing.
CALL app.grant_purposes('operations', 'SELECT', ARRAY['admit_due_targets']);
CALL app.grant_purposes('post_versions', 'SELECT', ARRAY['operation_rollup']);

SET ROLE shoutory_definer;

-- The follow-up parts of the version an operation was frozen with, for the variant of one channel and locale.
CREATE FUNCTION app.ledger_thread_parts(p_ws uuid, p_version uuid, p_channel uuid, p_locale text)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce((
    SELECT e.element -> 'parts'
      FROM app.post_versions AS pv
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pv.snapshot -> 'draft' -> 'variants') = 'array'
        THEN pv.snapshot -> 'draft' -> 'variants' ELSE '[]'::jsonb END) AS e (element)
      WHERE pv.workspace_id = p_ws AND pv.id = p_version AND lower(e.element ->> 'channel_id') = p_channel::text
        AND e.element ->> 'locale' IS NOT DISTINCT FROM p_locale AND jsonb_typeof(e.element -> 'parts') = 'array'
      LIMIT 1), '[]'::jsonb)
$$;

-- Inserts the next publish part or the next delete of a chain as the first state of its channel, with its event. A
-- publish part held for a reconnect holds its variant; a delete never changes the variant's state. A part that can
-- never be inserted is recorded as missed, which ends its chain.
CREATE FUNCTION app.ledger_insert_follow_up(
  p_ws uuid, p_variant uuid, p_channel uuid, p_provider text, p_queue text, p_kind text, p_part integer,
  p_parent uuid, p_marker text, p_requested_by uuid, p_lease integer, p_version uuid, p_hash bytea,
  p_refused boolean)
RETURNS TABLE (new_operation uuid, new_state text)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tolerance interval;
  ch text;
  st text;
  op_reason text;
BEGIN
  PERFORM 1 FROM app.post_variants AS v WHERE v.workspace_id = p_ws AND v.id = p_variant FOR NO KEY UPDATE;
  SELECT w.lateness_tolerance INTO tolerance FROM app.workspaces AS w WHERE w.id = p_ws;
  SELECT c.connection_state INTO ch FROM app.channels AS c WHERE c.workspace_id = p_ws AND c.id = p_channel FOR SHARE;
  IF p_refused THEN
    st := 'missed';
  ELSIF ch = 'connected' THEN
    st := 'pending';
  ELSIF ch = 'disabled' THEN
    st := 'paused'; op_reason := 'channel_disabled';
  ELSE
    st := 'blocked_reconnect'; op_reason := 'pending';
  END IF;
  new_operation := app.operation_insert(p_ws, jsonb_strip_nulls(jsonb_build_object(
    'variant_id', p_variant, 'channel_id', p_channel, 'provider_id', p_provider, 'queue', p_queue, 'kind', p_kind,
    'part_index', p_part, 'depends_on_operation_id', p_parent, 'state', st, 'reason_code', op_reason,
    'due_at', clock_timestamp(), 'lateness_deadline', clock_timestamp() + tolerance, 'next_attempt_at', clock_timestamp(),
    'blocked_since', CASE WHEN st = 'blocked_reconnect' THEN clock_timestamp() END,
    'idempotency_marker', p_marker, 'requested_by', p_requested_by, 'lease_seconds', p_lease,
    'frozen_version_id', p_version, 'frozen_snapshot_hash', encode(p_hash, 'hex'))), 'S');
  IF st = 'blocked_reconnect' AND p_kind = 'publish' THEN
    UPDATE app.post_variants AS v SET schedule_state = 'held' WHERE v.workspace_id = p_ws AND v.id = p_variant;
  END IF;
  INSERT INTO app.outbox (workspace_id, type, payload)
    VALUES (p_ws, 'operation.admitted', jsonb_build_object('operation_id', new_operation, 'state', st));
  new_state := st;
  RETURN NEXT;
END
$$;

-- A refused target comes back as a row with state `refused`, no operation and no queue, and the reason. The refusal of
-- the target index and of the guard is marked on the target; a media wait is not marked: it ends by itself. After the
-- targets, a thread whose part n is published gets part n+1, and a thread delete whose delete of a part is published
-- gets the delete of the next lower published part.
CREATE OR REPLACE FUNCTION app.admit_due_targets(p_limit integer, p_providers jsonb)
RETURNS TABLE (operation_id uuid, workspace_id uuid, queue text, state text, variant_id uuid, reason text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
  st text;
  op_reason text;
  tolerance interval;
  org uuid;
  ch text;
  secs integer;
  digest text;
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
    why := NULL;
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
        st := 'missed'; op_reason := NULL;
      ELSIF ch = 'connected' THEN
        st := 'pending'; op_reason := NULL;
      ELSIF ch = 'disabled' THEN
        st := 'paused'; op_reason := 'channel_disabled';
      ELSE
        st := 'blocked_reconnect'; op_reason := 'pending';
      END IF;
      secs := (p_providers -> r.provider_id -> 'lease_seconds' ->> 'publish')::integer;
      SELECT encode(pv.snapshot_hash, 'hex') INTO digest FROM app.post_versions AS pv
        WHERE pv.workspace_id = r.ws AND pv.id = r.frozen_version_id;
      new_op := app.operation_insert(r.ws, jsonb_strip_nulls(jsonb_build_object(
        'variant_id', r.vid, 'channel_id', r.channel_id, 'provider_id', r.provider_id,
        'queue', 'publish.' || r.provider_id, 'kind', 'publish', 'part_index', 0, 'state', st, 'reason_code', op_reason,
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
          WHERE v.workspace_id = r.ws AND v.id = r.vid;
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

-- The variant stays in progress while parts remain; its id, link and time are the root's. A part after the root that
-- ended without publishing settles the variant, and the post is then partially published, never published.
CREATE OR REPLACE FUNCTION app.ledger_rollup(p_ws uuid, p_variant uuid, p_fired text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  pid uuid;
  vchannel uuid;
  vlocale text;
  live boolean;
  held boolean;
  sent integer;
  top integer;
  cut boolean;
  more boolean;
  root uuid;
  root_version uuid;
  ext text;
  done_at timestamptz;
  link text;
  vstate text;
  targets integer;
  pub integer;
  away integer;
  broken integer;
  stuck boolean;
  busy boolean;
  pstatus text;
BEGIN
  PERFORM set_config('app.job_purpose', 'operation_rollup', true);
  SELECT v.post_id, v.channel_id, v.locale INTO pid, vchannel, vlocale
    FROM app.post_variants AS v WHERE v.workspace_id = p_ws AND v.id = p_variant;
  IF NOT FOUND THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN;
  END IF;
  SELECT coalesce(bool_or(o.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')), false),
      coalesce(bool_or(o.state IN ('needs_human', 'unverified', 'blocked_reconnect', 'paused')), false),
      count(*) FILTER (WHERE o.state = 'published'),
      coalesce(max(o.part_index) FILTER (WHERE o.state = 'published'), -1),
      coalesce(bool_or(o.part_index > 0 AND o.state IN ('failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')
        AND NOT EXISTS (SELECT 1 FROM app.operations AS d WHERE d.workspace_id = p_ws AND d.variant_id = p_variant
          AND d.kind = 'publish' AND d.part_index = o.part_index AND d.state = 'published')), false)
    INTO live, held, sent, top, cut FROM app.operations AS o
    WHERE o.workspace_id = p_ws AND o.variant_id = p_variant AND o.kind = 'publish';
  SELECT o.id, o.external_id, o.settled_at, o.frozen_version_id INTO root, ext, done_at, root_version
    FROM app.operations AS o
    WHERE o.workspace_id = p_ws AND o.variant_id = p_variant AND o.kind = 'publish' AND o.state = 'published'
      AND o.part_index = 0
    ORDER BY o.settled_at DESC LIMIT 1;
  SELECT e.permalink INTO link FROM app.operation_evidence AS e
    WHERE e.workspace_id = p_ws AND e.operation_id = root AND e.permalink IS NOT NULL
    ORDER BY e.observed_at DESC LIMIT 1;
  more := root IS NOT NULL AND NOT cut
    AND top < jsonb_array_length(app.ledger_thread_parts(p_ws, root_version, vchannel, vlocale));
  vstate := CASE WHEN live THEN CASE WHEN held THEN 'held' ELSE 'in_progress' END
    WHEN more THEN 'in_progress'
    WHEN sent > 0 OR p_fired IN ('published', 'failed', 'missed') THEN 'settled' ELSE 'draft' END;
  UPDATE app.post_variants AS v SET schedule_state = vstate,
      published_at = CASE WHEN sent > 0 THEN coalesce(v.published_at, done_at) ELSE v.published_at END,
      external_id = CASE WHEN sent > 0 THEN coalesce(ext, v.external_id) ELSE v.external_id END,
      permalink = CASE WHEN sent > 0 THEN coalesce(link, v.permalink) ELSE v.permalink END,
      updated_at = clock_timestamp()
    WHERE v.workspace_id = p_ws AND v.id = p_variant;
  SELECT count(*) FILTER (WHERE v.schedule_state <> 'draft'),
      count(*) FILTER (WHERE v.schedule_state = 'settled' AND v.published_at IS NOT NULL),
      count(*) FILTER (WHERE v.schedule_state = 'settled' AND v.published_at IS NOT NULL AND v.presence <> 'present'),
      coalesce(bool_or(v.schedule_state = 'held'), false),
      coalesce(bool_or(v.schedule_state IN ('scheduled', 'in_progress', 'approved', 'needs_approval')), false),
      count(*) FILTER (WHERE v.schedule_state = 'settled' AND v.published_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM app.operations AS o WHERE o.workspace_id = v.workspace_id AND o.variant_id = v.id
          AND o.kind = 'publish' AND o.part_index > 0
          AND o.state IN ('failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')
          AND NOT EXISTS (SELECT 1 FROM app.operations AS d WHERE d.workspace_id = v.workspace_id AND d.variant_id = v.id
            AND d.kind = 'publish' AND d.part_index = o.part_index AND d.state = 'published')))
    INTO targets, pub, away, stuck, busy, broken FROM app.post_variants AS v WHERE v.workspace_id = p_ws AND v.post_id = pid;
  pstatus := CASE WHEN stuck THEN 'needs_attention' WHEN busy THEN 'scheduled'
    WHEN pub > 0 AND pub = targets AND broken = 0 THEN 'published' WHEN pub > 0 THEN 'partially_published'
    WHEN p_fired = 'failed' THEN 'failed' WHEN p_fired = 'missed' THEN 'missed' ELSE 'draft' END;
  UPDATE app.posts AS p SET status = CASE WHEN p.status = 'archived' THEN p.status ELSE pstatus END,
      targets_total = targets, targets_published = pub, targets_published_not_live = away,
      published_at = CASE WHEN pstatus IN ('published', 'partially_published')
        THEN coalesce(p.published_at, clock_timestamp()) ELSE p.published_at END,
      updated_at = clock_timestamp()
    WHERE p.workspace_id = p_ws AND p.id = pid;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- A delete shows the post as removed only when the delete of part 0 is published: the deletes of the higher parts come
-- first and leave it pending. A chain that stopped shows removal_unknown, as does a delete that failed after a part
-- was already removed.
CREATE OR REPLACE FUNCTION app.operations_rollup()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  shown text;
BEGIN
  IF NEW.variant_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.kind = 'publish' THEN
    PERFORM app.ledger_rollup(NEW.workspace_id, NEW.variant_id, NEW.state);
  ELSIF NEW.kind = 'delete' THEN
    PERFORM set_config('app.job_purpose', 'operation_rollup', true);
    shown := CASE
      WHEN NEW.state = 'published' THEN CASE WHEN NEW.part_index = 0 THEN 'removed_at_provider' ELSE 'removal_pending' END
      WHEN NEW.state IN ('needs_human', 'unverified') THEN 'removal_unknown'
      WHEN NEW.state IN ('failed', 'cancelled', 'missed') THEN CASE WHEN NEW.effect = 'none' THEN
        CASE WHEN EXISTS (SELECT 1 FROM app.operations AS d WHERE d.workspace_id = NEW.workspace_id
          AND d.variant_id = NEW.variant_id AND d.kind = 'delete' AND d.state = 'published' AND d.id <> NEW.id)
          THEN 'removal_unknown' ELSE 'present' END END
      WHEN NEW.state = 'superseded_after_unknown_outcome' THEN NULL
      WHEN NEW.state IN ('blocked_reconnect', 'paused') AND TG_OP = 'UPDATE' THEN NULL
      ELSE 'removal_pending' END;
    IF shown IS NOT NULL THEN
      UPDATE app.post_variants AS v SET presence = shown, updated_at = clock_timestamp()
        WHERE v.workspace_id = NEW.workspace_id AND v.id = NEW.variant_id
          AND v.presence NOT IN ('removal_reported', shown);
      PERFORM app.ledger_rollup(NEW.workspace_id, NEW.variant_id, NULL);
    END IF;
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  END IF;
  RETURN NULL;
END
$$;

-- A reschedule takes the new local time, its zone and the instant the route worked out, and the instant must be ahead.
-- A person's confirmation that a part above the root was removed settles that part's delete, so its chain goes on; only
-- the root's confirmation reports the post as removed.
CREATE OR REPLACE FUNCTION app.resolve_operation(p_ws uuid, p_op uuid, p_kind text, p_args jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (new_operation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  who constant uuid := app.principal_id();
  seen record;
  st text;
  eff text;
  ch text;
  into_state text;
  tol interval;
  org uuid;
  made uuid;
  absent_ok boolean;
  ack text := nullif(btrim(p_args ->> 'ack_text'), '');
  stepped constant boolean := p_kind IN ('attest_published', 'attest_not_executed', 'supersede', 'confirm_removed');
  sends constant boolean := p_kind IN ('attest_not_executed', 'publish_late', 'supersede');
BEGIN
  PERFORM set_config('app.job_purpose', 'resolve_operation', true);
  PERFORM app.media_caller(p_ws, 3, false);
  IF p_kind IS NULL OR p_kind NOT IN ('attest_published', 'attest_not_executed', 'supersede', 'confirm_removed',
        'publish_late', 'reschedule', 'drop', 'dismiss')
     OR jsonb_typeof(p_args) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k
       WHERE k <> ALL (ARRAY['ack_text', 'note', 'permalink', 'absence_evidence_id', 'local_due', 'due_tz', 'due_at']))
     OR (p_kind IN ('attest_not_executed', 'supersede') AND ack IS NULL)
     OR (jsonb_exists(p_args, 'permalink')
       AND NOT coalesce((p_args ->> 'permalink') ~ '^https?://' AND char_length(p_args ->> 'permalink') <= 2048, false))
     OR (p_kind = 'reschedule'
       AND NOT (jsonb_typeof(p_args -> 'local_due') = 'string' AND jsonb_typeof(p_args -> 'due_tz') = 'string'
         AND jsonb_typeof(p_args -> 'due_at') = 'string'))
     OR (p_kind <> 'reschedule'
       AND (jsonb_exists(p_args, 'local_due') OR jsonb_exists(p_args, 'due_tz') OR jsonb_exists(p_args, 'due_at'))) THEN
    RAISE EXCEPTION 'resolve_operation: the kind or its arguments are not valid' USING ERRCODE = '22023';
  END IF;
  PERFORM app.ledger_prelock(p_ws, p_op);
  SELECT o.created_at, o.kind, o.channel_id, o.variant_id, o.provider_id, o.part_index, o.lease_seconds, o.frozen_version_id,
      o.frozen_snapshot_hash, p.id AS post_id, p.author_kind, p.author_id INTO seen
    FROM app.operations AS o
    JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
    JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
    WHERE o.workspace_id = p_ws AND o.id = p_op;
  IF NOT FOUND OR (app.tenancy_rank(p_ws, who) < 4 AND NOT (seen.author_kind = 'user' AND seen.author_id = who)) THEN
    RAISE EXCEPTION 'resolve_operation: refused' USING ERRCODE = '42501';
  END IF;
  IF p_kind = 'reschedule' AND (p_args ->> 'due_at')::timestamptz <= clock_timestamp() THEN
    RAISE EXCEPTION 'resolve_operation: in_the_past' USING ERRCODE = 'SH422';
  END IF;
  IF sends THEN
    SELECT c.connection_state INTO ch FROM app.channels AS c WHERE c.workspace_id = p_ws AND c.id = seen.channel_id FOR SHARE;
    IF ch IS DISTINCT FROM 'connected' THEN
      RAISE EXCEPTION 'resolve_operation: the channel is not connected, reconnect it first' USING ERRCODE = 'SH409';
    END IF;
  END IF;
  SELECT o.state, o.effect INTO st, eff FROM app.operations AS o
    WHERE o.workspace_id = p_ws AND o.id = p_op FOR NO KEY UPDATE;
  IF p_kind = 'reschedule' AND st = 'missed' AND EXISTS (SELECT 1 FROM app.operations AS n
      WHERE n.workspace_id = p_ws AND n.variant_id = seen.variant_id AND n.part_index = seen.part_index
        AND n.id <> p_op AND n.created_at > seen.created_at) THEN
    RAISE EXCEPTION 'resolve_operation: a newer operation exists for this target' USING ERRCODE = 'SH409';
  END IF;
  absent_ok := jsonb_exists(p_args, 'absence_evidence_id') AND EXISTS (SELECT 1 FROM app.operation_evidence AS e
    WHERE e.workspace_id = p_ws AND e.operation_id = p_op AND e.id = (p_args ->> 'absence_evidence_id')::uuid
      AND e.kind = 'absent' AND e.observed_at > coalesce((SELECT a.started_at FROM app.operation_attempts AS a
        WHERE a.workspace_id = p_ws AND a.operation_id = p_op ORDER BY a.attempt_no DESC LIMIT 1), '-infinity'));
  into_state := CASE p_kind
    WHEN 'attest_published' THEN CASE WHEN st IN ('needs_human', 'unverified') THEN 'published' END
    WHEN 'attest_not_executed' THEN CASE WHEN st = 'needs_human' THEN 'retry_wait' END
    WHEN 'publish_late' THEN CASE WHEN eff = 'none' AND st = 'needs_human' THEN 'retry_wait'
      WHEN eff = 'none' AND st = 'missed' THEN 'missed' END
    WHEN 'reschedule' THEN CASE WHEN (eff = 'none' OR absent_ok) AND st = 'needs_human' THEN 'cancelled'
      WHEN eff = 'none' AND st = 'missed' THEN 'missed' END
    WHEN 'drop' THEN CASE WHEN (eff = 'none' OR absent_ok) AND st = 'needs_human' THEN 'cancelled' END
    WHEN 'dismiss' THEN CASE WHEN st = 'needs_human' THEN 'unverified' END
    WHEN 'supersede' THEN CASE WHEN st IN ('needs_human', 'unverified') THEN 'superseded_after_unknown_outcome' END
    WHEN 'confirm_removed' THEN CASE WHEN st = 'needs_human' AND seen.kind = 'delete' THEN 'published' END END;
  IF into_state IS NULL THEN
    RAISE EXCEPTION 'resolve_operation: % is not allowed from this state', p_kind USING ERRCODE = 'SH409';
  END IF;
  SELECT w.lateness_tolerance, w.organization_id INTO tol, org FROM app.workspaces AS w WHERE w.id = p_ws;
  IF p_kind = 'supersede' OR (p_kind = 'publish_late' AND st = 'missed') THEN
    PERFORM app.operation_media_lock(p_ws, seen.frozen_version_id, p_op);
  END IF;
  IF p_kind IN ('attest_published', 'attest_not_executed', 'confirm_removed') THEN
    INSERT INTO app.operation_evidence (workspace_id, operation_id, part_index, kind, level, outcome_kind, permalink, source)
      VALUES (p_ws, p_op, seen.part_index, CASE p_kind WHEN 'confirm_removed' THEN 'removed' ELSE 'human_confirmed' END,
        'human', CASE WHEN p_kind = 'attest_published' THEN 'post' END, p_args ->> 'permalink', 'resolver');
  END IF;
  IF into_state <> st THEN
    UPDATE app.operations AS o SET state = into_state, last_actor = 'U', reason_code = NULL, blocked_since = NULL,
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, processing_deadline = NULL, poll_deadline = NULL,
        effect = CASE WHEN p_kind IN ('attest_not_executed', 'drop', 'reschedule') THEN 'none' ELSE o.effect END,
        queue = CASE WHEN into_state = 'retry_wait' THEN 'publish.' || o.provider_id ELSE o.queue END,
        next_attempt_at = CASE WHEN into_state = 'retry_wait' THEN clock_timestamp() ELSE o.next_attempt_at END,
        lateness_deadline = CASE WHEN p_kind = 'publish_late' THEN clock_timestamp() + tol ELSE o.lateness_deadline END
      WHERE o.workspace_id = p_ws AND o.id = p_op AND o.state = st;
    INSERT INTO app.outbox (workspace_id, type, payload)
      VALUES (p_ws, 'operation.' || into_state, jsonb_build_object('operation_id', p_op, 'from', st, 'to', into_state));
  END IF;
  INSERT INTO app.operation_resolutions (workspace_id, operation_id, kind, actor, ack_text, step_up_at, absence_evidence_id,
      note)
    VALUES (p_ws, p_op, p_kind, who, ack, CASE WHEN stepped THEN clock_timestamp() END,
      (p_args ->> 'absence_evidence_id')::uuid, p_args ->> 'note');
  IF p_kind = 'supersede' OR (p_kind = 'publish_late' AND st = 'missed') THEN
    made := app.operation_insert(p_ws, jsonb_strip_nulls(jsonb_build_object(
      'variant_id', seen.variant_id, 'channel_id', seen.channel_id, 'provider_id', seen.provider_id,
      'queue', 'publish.' || seen.provider_id, 'kind', seen.kind, 'part_index', seen.part_index, 'state', 'pending',
      'due_at', clock_timestamp(), 'lateness_deadline', clock_timestamp() + tol, 'next_attempt_at', clock_timestamp(),
      'idempotency_marker', 'resolve-' || uuidv7()::text, 'requested_by', who, 'lease_seconds', seen.lease_seconds,
      'supersedes_operation_id', p_op, 'frozen_version_id', seen.frozen_version_id,
      'frozen_snapshot_hash', encode(seen.frozen_snapshot_hash, 'hex'))), 'U');
    PERFORM app.operation_media_pin(p_ws, made, seen.frozen_version_id);
    INSERT INTO app.usage_reservations (workspace_id, organization_id, operation_id, key, amount)
      VALUES (p_ws, org, made, 'posts_per_month', 1);
    IF p_kind = 'supersede' THEN
      UPDATE app.operations AS o SET superseded_by_operation_id = made WHERE o.workspace_id = p_ws AND o.id = p_op;
    END IF;
    INSERT INTO app.outbox (workspace_id, type, payload)
      VALUES (p_ws, 'operation.admitted', jsonb_build_object('operation_id', made, 'state', 'pending'));
    PERFORM app.ledger_rollup(p_ws, seen.variant_id, 'pending');
  ELSIF p_kind = 'reschedule' THEN
    UPDATE app.post_variants AS v SET schedule_state = 'scheduled', local_due = (p_args ->> 'local_due')::timestamp,
        due_tz = p_args ->> 'due_tz', due_at = (p_args ->> 'due_at')::timestamptz, admit_skip_until = NULL,
        updated_at = clock_timestamp()
      WHERE v.workspace_id = p_ws AND v.id = seen.variant_id;
    UPDATE app.posts AS p SET status = 'scheduled', updated_at = clock_timestamp()
      WHERE p.workspace_id = p_ws AND p.id = seen.post_id AND p.status <> 'archived';
  ELSIF p_kind = 'confirm_removed' AND seen.part_index = 0 THEN
    UPDATE app.post_variants AS v SET presence = 'removal_reported', updated_at = clock_timestamp()
      WHERE v.workspace_id = p_ws AND v.id = seen.variant_id;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  new_operation_id := made;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION app.ledger_thread_parts(uuid, uuid, uuid, text),
  app.ledger_insert_follow_up(uuid, uuid, uuid, text, text, text, integer, uuid, text, uuid, integer, uuid, bytea,
    boolean),
  app.ledger_rollup(uuid, uuid, text), app.operations_rollup(), app.admit_due_targets(integer, jsonb),
  app.resolve_operation(uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admit_due_targets(integer, jsonb) TO shoutory_worker;
GRANT EXECUTE ON FUNCTION app.resolve_operation(uuid, uuid, text, jsonb) TO shoutory_app;
RESET ROLE;
