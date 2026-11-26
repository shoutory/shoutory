-- A row that admission or a sweep refuses is skipped for five minutes, so refused rows never fill the front of a scan
-- and starve the rows behind them. The skip is a mark on the row, not a state, so the schedule of a post is never changed.
ALTER TABLE app.post_variants ADD COLUMN admit_skip_until timestamptz;
ALTER TABLE app.operations ADD COLUMN sweep_skip_until timestamptz;
GRANT UPDATE (admit_skip_until, local_due, due_tz, due_at) ON app.post_variants TO shoutory_definer;
GRANT UPDATE (sweep_skip_until) ON app.operations TO shoutory_definer;

DROP FUNCTION app.admit_due_targets(integer, jsonb);
DROP FUNCTION app.sweep_due_moves(jsonb);
DROP FUNCTION app.operation_attempt_start(uuid, uuid, bigint, text, text, jsonb);

SET ROLE shoutory_definer;

-- Marks one refused operation under the locks of a sweep (post, target, operation). False when the row moved on or
-- another transaction holds it; the next sweep meets it again.
CREATE FUNCTION app.ledger_skip(p_ws uuid, p_op uuid, p_state text, p_token bigint)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT app.ledger_lock_target(p_ws, p_op, p_state, p_token) THEN
    RETURN false;
  END IF;
  UPDATE app.operations AS o SET sweep_skip_until = clock_timestamp() + interval '5 minutes'
    WHERE o.workspace_id = p_ws AND o.id = p_op;
  RETURN true;
END
$$;

-- A refused target comes back as a row with state `refused`, no operation and no queue, and the reason. The refusal of
-- the target index and of the guard is marked on the target; a media wait is not marked: it ends by itself.
CREATE FUNCTION app.admit_due_targets(p_limit integer, p_providers jsonb)
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
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'admit_due_targets', true);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR jsonb_typeof(p_providers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'admit_due_targets: the limit is 1 to 500 and the providers an object' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(p_providers) AS e (provider, facts)
      WHERE NOT coalesce(jsonb_typeof(e.facts -> 'lease_seconds' -> 'publish') = 'number'
        AND (e.facts -> 'lease_seconds' ->> 'publish') ~ '^[1-9][0-9]{0,8}$', false)) THEN
    RAISE EXCEPTION 'admit_due_targets: the publish lease of every provider is a positive whole number of seconds'
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
  PERFORM set_config('app.job_purpose', 'ledger', true);
END
$$;

-- Answers {moved, refused: [{id, reason}]}: a row whose move the guard refuses is marked and listed once.
CREATE FUNCTION app.sweep_due_moves(p_live_providers jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
  moved integer := 0;
  refused jsonb := '[]'::jsonb;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'sweep_due_moves', true);
  IF jsonb_typeof(p_live_providers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'sweep_due_moves: the live providers are an object' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, o.fencing_token AS tok FROM app.operations AS o
      WHERE o.state = 'retry_wait' AND o.effect = 'none' AND jsonb_exists(p_live_providers, o.provider_id)
        AND o.attempt_count >= (p_live_providers -> o.provider_id ->> 'max_attempts')::integer
        AND (o.sweep_skip_until IS NULL OR o.sweep_skip_until <= clock_timestamp())
      ORDER BY o.id LIMIT 500
  LOOP
    BEGIN
      IF app.ledger_lock_target(r.ows, r.oid, r.was, r.tok) THEN
        UPDATE app.operations AS o SET state = 'failed', last_actor = 'S' WHERE o.workspace_id = r.ows AND o.id = r.oid;
        INSERT INTO app.outbox (workspace_id, type, payload)
          VALUES (r.ows, 'operation.failed', jsonb_build_object('operation_id', r.oid, 'from', r.was, 'to', 'failed'));
        moved := moved + 1;
      END IF;
    EXCEPTION WHEN SQLSTATE 'SH409' THEN
      IF app.ledger_skip(r.ows, r.oid, r.was, r.tok) THEN
        refused := refused || jsonb_build_array(jsonb_build_object('id', r.oid, 'reason', 'guard_refused'));
      END IF;
    END;
  END LOOP;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, o.fencing_token AS tok FROM app.operations AS o
      WHERE o.state IN ('reconciling', 'unknown_external_state') AND o.unverified_until <= clock_timestamp()
        AND jsonb_exists(p_live_providers, o.provider_id)
        AND (o.lease_expires_at IS NULL OR o.lease_expires_at < clock_timestamp())
        AND (o.sweep_skip_until IS NULL OR o.sweep_skip_until <= clock_timestamp())
      ORDER BY o.id LIMIT 500
  LOOP
    BEGIN
      IF app.ledger_lock_target(r.ows, r.oid, r.was, r.tok) THEN
        UPDATE app.operations AS o SET state = 'unverified', last_actor = 'S', lease_owner = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL WHERE o.workspace_id = r.ows AND o.id = r.oid;
        INSERT INTO app.outbox (workspace_id, type, payload)
          VALUES (r.ows, 'operation.unverified', jsonb_build_object('operation_id', r.oid, 'from', r.was, 'to', 'unverified'));
        moved := moved + 1;
      END IF;
    EXCEPTION WHEN SQLSTATE 'SH409' THEN
      IF app.ledger_skip(r.ows, r.oid, r.was, r.tok) THEN
        refused := refused || jsonb_build_array(jsonb_build_object('id', r.oid, 'reason', 'guard_refused'));
      END IF;
    END;
  END LOOP;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, o.fencing_token AS tok FROM app.channels AS c
      JOIN app.operations AS o ON o.workspace_id = c.workspace_id AND o.channel_id = c.id
      WHERE c.connection_state = 'connected' AND o.state = 'paused' AND o.reason_code = 'channel_disabled'
        AND (o.sweep_skip_until IS NULL OR o.sweep_skip_until <= clock_timestamp())
      ORDER BY o.id LIMIT 500
  LOOP
    BEGIN
      IF app.ledger_lock_target(r.ows, r.oid, r.was, r.tok) THEN
        PERFORM app.ledger_due_move(r.ows, r.oid);
        moved := moved + 1;
      END IF;
    EXCEPTION WHEN SQLSTATE 'SH409' THEN
      IF app.ledger_skip(r.ows, r.oid, r.was, r.tok) THEN
        refused := refused || jsonb_build_array(jsonb_build_object('id', r.oid, 'reason', 'guard_refused'));
      END IF;
    END;
  END LOOP;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, o.fencing_token AS tok FROM app.operations AS o
      WHERE o.state IN ('pending', 'retry_wait', 'paused')
        AND ((o.effect = 'none' AND clock_timestamp() > o.lateness_deadline + o.blocked_total)
          OR (o.state = 'retry_wait' AND o.next_attempt_at <= clock_timestamp())
          OR (o.state = 'paused' AND o.reason_code = 'provider_cooldown' AND o.next_attempt_at <= clock_timestamp())
          OR (o.state = 'paused' AND o.reason_code = 'api_sunset' AND jsonb_exists(p_live_providers, o.provider_id)))
        AND (o.sweep_skip_until IS NULL OR o.sweep_skip_until <= clock_timestamp())
      ORDER BY o.id LIMIT 500
  LOOP
    BEGIN
      IF app.ledger_lock_target(r.ows, r.oid, r.was, r.tok) THEN
        PERFORM app.ledger_due_move(r.ows, r.oid);
        moved := moved + 1;
      END IF;
    EXCEPTION WHEN SQLSTATE 'SH409' THEN
      IF app.ledger_skip(r.ows, r.oid, r.was, r.tok) THEN
        refused := refused || jsonb_build_array(jsonb_build_object('id', r.oid, 'reason', 'guard_refused'));
      END IF;
    END;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
  RETURN jsonb_build_object('moved', moved, 'refused', refused);
END
$$;

-- A denied start answers the seconds until every denied key has a free slot again: the latest of the times at which
-- the oldest counted send of each full key leaves its window.
CREATE FUNCTION app.operation_attempt_start(
  p_ws uuid, p_op uuid, p_token bigint, p_owner text, p_step text, p_quotas jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, attempt_id uuid, attempt_no integer, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  r record;
  acct text;
  k text;
  mutex text;
  used integer;
  capacity integer;
  win integer;
  frees timestamptz;
  wait_s integer := 0;
  denied boolean := false;
  n integer;
  aid constant uuid := uuidv7();
BEGIN
  PERFORM app.ledger_caller();
  IF NOT coalesce(p_ws = ANY (app.ws_ids()), false) THEN
    RAISE EXCEPTION 'ledger: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.job_purpose', 'operation_attempt_start', true);
  IF p_step IS NULL OR p_step NOT IN ('prepare', 'commit', 'poll', 'read_back') OR p_owner IS NULL
     OR char_length(p_owner) NOT BETWEEN 1 AND 128 OR jsonb_typeof(p_quotas) IS DISTINCT FROM 'object'
     OR (p_step <> 'commit' AND p_quotas <> '{}'::jsonb)
     OR EXISTS (SELECT 1 FROM jsonb_each(p_quotas) AS e (qkey, facts)
       WHERE NOT coalesce(jsonb_typeof(e.facts) = 'object' AND (e.facts ->> 'capacity') ~ '^[1-9][0-9]{0,4}$'
         AND (e.facts ->> 'window_seconds') ~ '^[1-9][0-9]{0,5}$' AND char_length(e.qkey) BETWEEN 1 AND 64
         AND (e.facts ->> 'capacity')::integer <= 10000 AND (e.facts ->> 'window_seconds')::integer <= 86400, false)) THEN
    RAISE EXCEPTION 'operation_attempt_start: the step, the owner or the quotas are not valid' USING ERRCODE = '22023';
  END IF;
  SELECT o.state, o.effect, o.attempt_count, o.provider_id, o.channel_id INTO r FROM app.operations AS o
    WHERE o.workspace_id = p_ws AND o.id = p_op AND o.fencing_token = p_token AND o.lease_owner = p_owner
      AND o.lease_expires_at > clock_timestamp() FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    outcome := 'lost_lease';
    RETURN NEXT;
    RETURN;
  END IF;
  IF (p_step, r.state) NOT IN (('commit', 'claimed'), ('commit', 'processing'), ('prepare', 'claimed'),
      ('prepare', 'processing'), ('poll', 'processing'), ('poll', 'provider_accepted'), ('read_back', 'reconciling')) THEN
    RAISE EXCEPTION 'operation_attempt_start: this step is not allowed in this state' USING ERRCODE = 'SH409';
  END IF;
  IF p_quotas <> '{}'::jsonb THEN
    SELECT c.provider_account_id INTO acct FROM app.channels AS c WHERE c.workspace_id = p_ws AND c.id = r.channel_id;
    IF acct IS NULL THEN
      RAISE EXCEPTION 'operation_attempt_start: a quota needs a provider account' USING ERRCODE = 'SH409';
    END IF;
    FOR k IN SELECT x FROM jsonb_object_keys(p_quotas) AS x ORDER BY x LOOP
      mutex := encode(sha256(convert_to('quota' || chr(31) || r.provider_id || chr(31) || acct || chr(31) || k, 'UTF8')),
        'hex');
      INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('account', mutex, 1)
        ON CONFLICT ON CONSTRAINT rate_buckets_pkey DO NOTHING;
      PERFORM 1 FROM app.rate_buckets AS b WHERE b.scope = 'account' AND b.key = mutex FOR UPDATE;
      capacity := (p_quotas -> k ->> 'capacity')::integer;
      win := (p_quotas -> k ->> 'window_seconds')::integer;
      SELECT count(*) INTO used FROM app.provider_quota_ledger AS l
        WHERE l.provider_id = r.provider_id AND l.provider_account_id = acct AND l.quota_key = k AND l.state <> 'refunded'
          AND l.at > clock_timestamp() - make_interval(secs => win);
      IF used >= capacity THEN
        SELECT l.at INTO frees FROM app.provider_quota_ledger AS l
          WHERE l.provider_id = r.provider_id AND l.provider_account_id = acct AND l.quota_key = k AND l.state <> 'refunded'
            AND l.at > clock_timestamp() - make_interval(secs => win)
          ORDER BY l.at OFFSET used - capacity LIMIT 1;
        wait_s := greatest(wait_s, ceil(extract(epoch FROM frees + make_interval(secs => win) - clock_timestamp()))::integer);
        denied := true;
      END IF;
    END LOOP;
    IF denied THEN
      PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
      outcome := 'quota_denied';
      retry_after_seconds := greatest(wait_s, 1);
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;
  SELECT coalesce(max(a.attempt_no), 0) + 1 INTO n FROM app.operation_attempts AS a
    WHERE a.workspace_id = p_ws AND a.operation_id = p_op;
  IF p_step = 'commit' THEN
    UPDATE app.operations AS o SET state = 'dispatching', effect = 'possible', attempt_count = r.attempt_count + 1,
        last_actor = CASE r.state WHEN 'claimed' THEN 'W' ELSE 'P' END
      WHERE o.workspace_id = p_ws AND o.id = p_op;
    INSERT INTO app.outbox (workspace_id, type, payload)
      VALUES (p_ws, 'operation.dispatching', jsonb_build_object('operation_id', p_op, 'from', r.state, 'to', 'dispatching'));
  END IF;
  INSERT INTO app.operation_attempts (id, workspace_id, operation_id, attempt_no, step, fencing_token, effect_started_at,
      effect)
    VALUES (aid, p_ws, p_op, n, p_step, p_token, CASE WHEN p_step = 'commit' THEN clock_timestamp() END,
      CASE WHEN p_step = 'commit' THEN 'possible' ELSE r.effect END);
  FOR k IN SELECT x FROM jsonb_object_keys(p_quotas) AS x ORDER BY x LOOP
    INSERT INTO app.provider_quota_ledger (workspace_id, provider_id, provider_account_id, quota_key, operation_id,
        attempt_id)
      VALUES (p_ws, r.provider_id, acct, k, p_op, aid);
  END LOOP;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  outcome := 'started';
  attempt_id := aid;
  attempt_no := n;
  RETURN NEXT;
END
$$;

-- A reschedule takes the new local time, its zone and the instant the route worked out, and the instant must be ahead.
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
  ELSIF p_kind = 'confirm_removed' THEN
    UPDATE app.post_variants AS v SET presence = 'removal_reported', updated_at = clock_timestamp()
      WHERE v.workspace_id = p_ws AND v.id = seen.variant_id;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  new_operation_id := made;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION app.ledger_skip(uuid, uuid, text, bigint), app.admit_due_targets(integer, jsonb),
  app.sweep_due_moves(jsonb), app.operation_attempt_start(uuid, uuid, bigint, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admit_due_targets(integer, jsonb), app.sweep_due_moves(jsonb),
  app.operation_attempt_start(uuid, uuid, bigint, text, text, jsonb) TO shoutory_worker;
RESET ROLE;
