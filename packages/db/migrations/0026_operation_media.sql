-- The pin of an operation's media: the exact object each medium of an operation is sent as, recorded in the transaction
-- that creates the operation, so the collection and a later edit can never change or remove what it sends. One definer
-- locks the media and another writes the rows; the two functions that create operations (admission and the resolutions
-- that send again) call them. Nothing else writes `operation_media`; no runtime role may call either.

GRANT INSERT ON app.operation_media TO shoutory_definer;

-- What the two functions read and write, each under its own purpose. Both read the operation and its variant (the channel
-- and the locale pick the variant of the frozen snapshot), the snapshot, the media and their stripped copies. The lock
-- takes the assets for share (a row lock passes the UPDATE policy); the pin inserts the rows and takes no lock.
CALL app.grant_purposes('operations', 'SELECT', ARRAY['operation_media_lock', 'operation_media_pin']);
CALL app.grant_purposes('post_variants', 'SELECT', ARRAY['operation_media_lock', 'operation_media_pin']);
CALL app.grant_purposes('post_versions', 'SELECT', ARRAY['operation_media_lock', 'operation_media_pin']);
CALL app.grant_purposes('media_assets', 'SELECT', ARRAY['operation_media_lock', 'operation_media_pin']);
CALL app.grant_purposes('media_derivatives', 'SELECT', ARRAY['operation_media_lock', 'operation_media_pin']);
CALL app.grant_purposes('media_assets', 'UPDATE', ARRAY['operation_media_lock']);
CALL app.grant_purposes('operation_media', 'INSERT', ARRAY['operation_media_pin']);

SET ROLE shoutory_definer;

-- Locks the media of the frozen version for the operation's channel and locale FOR SHARE, in ascending id (OL 4.4 row 7a),
-- which conflicts with the take of the collection and with a post attach, so the pin and either of them are serialized
-- whichever comes first; the assets are read again once locked. A medium that is missing, in another workspace, not ready,
-- or an image with no ready `stripped` copy raises SH422: admission leaves the target scheduled, and a resolution answers
-- `media_unavailable`. A version that is not frozen (NULL) has nothing to lock. It is called before an operation that
-- sends again is moved, because the move fires triggers that write ranks above the assets (OL 4.4 row 7a), and it takes
-- the operation that carries the channel and the locale, which a resolution has before the new one exists.
CREATE FUNCTION app.operation_media_lock(p_ws uuid, p_version uuid, p_op uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  ids uuid[];
  total integer;
  bad integer;
  ready integer;
BEGIN
  IF p_version IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.job_purpose', 'operation_media_lock', true);
  -- The media the version's draft lists for the channel and locale of the operation; a key that is no uuid is a medium that
  -- cannot be ready.
  SELECT array_agg(DISTINCT (m.item ->> 'media_id')::uuid) FILTER (WHERE valid.ok), count(*),
      count(*) FILTER (WHERE NOT valid.ok) INTO ids, total, bad
    FROM app.operations AS o
      JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
      JOIN app.post_versions AS pv ON pv.workspace_id = o.workspace_id AND pv.id = p_version
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pv.snapshot -> 'draft' -> 'variants') = 'array'
        THEN pv.snapshot -> 'draft' -> 'variants' ELSE '[]'::jsonb END) AS dv (item)
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(dv.item -> 'media') = 'array'
        THEN dv.item -> 'media' ELSE '[]'::jsonb END) AS m (item)
      CROSS JOIN LATERAL (SELECT coalesce(m.item ->> 'media_id' ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) AS ok) AS valid
    WHERE o.workspace_id = p_ws AND o.id = p_op AND lower(dv.item ->> 'channel_id') = o.channel_id::text
      AND dv.item ->> 'locale' IS NOT DISTINCT FROM v.locale;
  IF total > 0 THEN
    PERFORM a.id FROM app.media_assets AS a WHERE a.workspace_id = p_ws AND a.id = ANY (ids) ORDER BY a.id FOR SHARE;
    SELECT count(*) INTO ready FROM app.media_assets AS a
      WHERE a.workspace_id = p_ws AND a.id = ANY (ids) AND a.state = 'ready'
        AND (a.mime LIKE 'video/%' OR EXISTS (SELECT 1 FROM app.media_derivatives AS d
          WHERE d.workspace_id = a.workspace_id AND d.media_id = a.id AND d.profile = 'stripped' AND d.state = 'ready'));
    IF bad > 0 OR ready <> coalesce(cardinality(ids), 0) THEN
      RAISE EXCEPTION 'resolve_operation: media_unavailable' USING ERRCODE = 'SH422';
    END IF;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Pins the media of the frozen version for the operation: for each medium the version's draft lists for the operation's
-- own channel and locale, in the order it lists them, one row with the id of the ready `stripped` copy and its hash (an
-- image), or no copy and the hash of the original (a video, which is sent as it is). A version that is not frozen (NULL)
-- pins nothing. It takes no lock (the lock above is called first, so nothing it reads can change) and checks that it wrote
-- one row for every medium, and raises the same SH422 when it did not.
CREATE FUNCTION app.operation_media_pin(p_ws uuid, p_op uuid, p_version uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  items jsonb;
  written integer;
BEGIN
  IF p_version IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.job_purpose', 'operation_media_pin', true);
  -- The media the version's draft lists for this operation's channel and locale, with their positions; a key that is no
  -- uuid is a medium that cannot be ready.
  SELECT coalesce(jsonb_agg(jsonb_build_object('pos', m.ord - 1,
      'media_id', CASE WHEN m.item ->> 'media_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN m.item ->> 'media_id' END) ORDER BY m.ord), '[]'::jsonb) INTO items
    FROM app.operations AS o
      JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
      JOIN app.post_versions AS pv ON pv.workspace_id = o.workspace_id AND pv.id = p_version
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pv.snapshot -> 'draft' -> 'variants') = 'array'
        THEN pv.snapshot -> 'draft' -> 'variants' ELSE '[]'::jsonb END) AS dv (item)
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(dv.item -> 'media') = 'array'
        THEN dv.item -> 'media' ELSE '[]'::jsonb END) WITH ORDINALITY AS m (item, ord)
    WHERE o.workspace_id = p_ws AND o.id = p_op AND lower(dv.item ->> 'channel_id') = o.channel_id::text
      AND dv.item ->> 'locale' IS NOT DISTINCT FROM v.locale;
  INSERT INTO app.operation_media (workspace_id, operation_id, position, media_id, derivative_id, derivative_sha256)
    SELECT p_ws, p_op, i.pos, i.media_id, d.id, coalesce(d.sha256, a.sha256)
    FROM jsonb_to_recordset(items) AS i (pos smallint, media_id uuid)
      JOIN app.media_assets AS a ON a.workspace_id = p_ws AND a.id = i.media_id AND a.state = 'ready'
      LEFT JOIN app.media_derivatives AS d ON d.workspace_id = a.workspace_id AND d.media_id = a.id
        AND d.profile = 'stripped' AND d.state = 'ready' AND a.mime NOT LIKE 'video/%'
    WHERE d.id IS NOT NULL OR a.mime LIKE 'video/%';
  GET DIAGNOSTICS written = ROW_COUNT;
  IF written <> jsonb_array_length(items) THEN
    RAISE EXCEPTION 'resolve_operation: media_unavailable' USING ERRCODE = 'SH422';
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Admission of 0023, with one change: the operation it creates locks and pins its media in the same subtransaction, and a
-- medium that is no longer ready (SH422) leaves the target `scheduled` like the unlocked check of the row query, which
-- stays as the cheap filter. A missed operation sends nothing and pins nothing.
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
  -- The lease of a provider is a positive whole number of seconds; a value that is not is the caller's defect and no target is read.
  IF EXISTS (SELECT 1 FROM jsonb_each(p_providers) AS e (provider, facts)
      WHERE NOT coalesce(jsonb_typeof(e.facts -> 'lease_seconds' -> 'publish') = 'number'
        AND (e.facts -> 'lease_seconds' ->> 'publish') ~ '^[1-9][0-9]{0,8}$', false)) THEN
    RAISE EXCEPTION 'admit_due_targets: the publish lease of every provider is a positive whole number of seconds'
      USING ERRCODE = '22023';
  END IF;
  -- Only the target row is locked (OF v). The workspace row is read, not locked; it is named first because the
  -- lock-order check counts every table of a locking statement and the workspace rank comes before the target's.
  FOR r IN
    SELECT v.id AS variant_id, v.workspace_id AS ws, v.channel_id, v.due_at, v.frozen_version_id, c.provider_id,
        p.author_id, p.id AS post_id
      FROM app.workspaces AS w
      JOIN app.post_variants AS v ON v.workspace_id = w.id
      JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      WHERE v.schedule_state = 'scheduled' AND v.due_at IS NOT NULL AND p.deleted_at IS NULL AND p.status <> 'archived'
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

-- Resolution of 0022, with one change: the operation that a `supersede` or a `publish_late` of a missed operation creates
-- locks (before the old operation is moved) and pins the media of the frozen snapshot of the operation it replaces, in the
-- same transaction; a medium that is no longer ready raises SH422 and nothing the call did is kept.
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
       WHERE k <> ALL (ARRAY['ack_text', 'note', 'permalink', 'absence_evidence_id']))
     OR (p_kind IN ('attest_not_executed', 'supersede') AND ack IS NULL)
     OR (jsonb_exists(p_args, 'permalink')
       AND NOT coalesce((p_args ->> 'permalink') ~ '^https?://' AND char_length(p_args ->> 'permalink') <= 2048, false)) THEN
    RAISE EXCEPTION 'resolve_operation: the kind or its arguments are not valid' USING ERRCODE = '22023';
  END IF;
  PERFORM app.ledger_prelock(p_ws, p_op);
  SELECT o.kind, o.channel_id, o.variant_id, o.provider_id, o.part_index, o.lease_seconds, o.frozen_version_id,
      o.frozen_snapshot_hash, p.id AS post_id, p.author_kind, p.author_id INTO seen
    FROM app.operations AS o
    JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
    JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
    WHERE o.workspace_id = p_ws AND o.id = p_op;
  IF NOT FOUND OR (app.tenancy_rank(p_ws, who) < 4 AND NOT (seen.author_kind = 'user' AND seen.author_id = who)) THEN
    RAISE EXCEPTION 'resolve_operation: refused' USING ERRCODE = '42501';
  END IF;
  IF sends THEN
    SELECT c.connection_state INTO ch FROM app.channels AS c WHERE c.workspace_id = p_ws AND c.id = seen.channel_id FOR SHARE;
    IF ch IS DISTINCT FROM 'connected' THEN
      RAISE EXCEPTION 'resolve_operation: the channel is not connected, reconnect it first' USING ERRCODE = 'SH409';
    END IF;
  END IF;
  SELECT o.state, o.effect INTO st, eff FROM app.operations AS o
    WHERE o.workspace_id = p_ws AND o.id = p_op FOR NO KEY UPDATE;
  -- OL 6.1 row 44: a drop or a reschedule of a post that may have been sent needs `absent` evidence of this operation
  -- that was read after its latest attempt began (any, when it has no attempt); the move then resets the effect.
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
  -- The operation that sends again pins the media of this one's frozen snapshot, so they are locked now, after this
  -- operation's row lock and before it is moved: the move fires triggers that write ranks above the assets.
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
    UPDATE app.post_variants AS v SET schedule_state = 'scheduled', updated_at = clock_timestamp()
      WHERE v.workspace_id = p_ws AND v.id = seen.variant_id;
    UPDATE app.posts AS p SET status = 'scheduled', updated_at = clock_timestamp()
      WHERE p.workspace_id = p_ws AND p.id = seen.post_id AND p.status <> 'archived';
  ELSIF p_kind = 'confirm_removed' THEN
    UPDATE app.post_variants AS v SET presence = 'removal_reported', updated_at = clock_timestamp()
      WHERE v.workspace_id = p_ws AND v.id = seen.variant_id;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  new_operation_id := made;
  RETURN NEXT;
END
$$;

-- The lock and the writer of the pin have no runtime caller, like the writer of operations: only the two functions above
-- call them, as the definer role, after their own checks.
REVOKE ALL ON FUNCTION app.operation_media_lock(uuid, uuid, uuid), app.operation_media_pin(uuid, uuid, uuid),
  app.admit_due_targets(integer, jsonb), app.resolve_operation(uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admit_due_targets(integer, jsonb) TO shoutory_worker;
GRANT EXECUTE ON FUNCTION app.resolve_operation(uuid, uuid, text, jsonb) TO shoutory_app;
RESET ROLE;
