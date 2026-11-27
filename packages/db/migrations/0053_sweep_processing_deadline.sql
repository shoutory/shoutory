-- An operation still processing past its deadline with no poller on it is moved by the sweep: back to retry_wait while
-- attempts remain (the move raises the token), failed once they are used up. A live lease wins over the deadline until
-- it ends, so a poller that is working on the row is never moved from under. A poller that finds the medium still
-- processing sets the next check and ends its own lease in one write, so the row is polled again when it is due.
-- A commit start from processing leaves the deadline behind with the state, as every other move out of processing does.
-- A move from processing back to retry_wait is a timeout and counts as an attempt, so a video that never finishes
-- ends failed once the attempts are used up.
DROP FUNCTION app.sweep_due_moves(jsonb);
DROP FUNCTION app.operation_record_progress(uuid, uuid, bigint, text, jsonb);
DROP FUNCTION app.operation_attempt_start(uuid, uuid, bigint, text, text, jsonb);

SET ROLE shoutory_definer;

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
  entered text;
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
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, o.fencing_token AS tok,
        o.attempt_count + 1 >= (p_live_providers -> o.provider_id ->> 'max_attempts')::integer AS spent
      FROM app.operations AS o
      WHERE o.state = 'processing' AND o.effect = 'none' AND o.processing_deadline <= clock_timestamp()
        AND jsonb_exists(p_live_providers, o.provider_id)
        AND (o.lease_expires_at IS NULL OR o.lease_expires_at < clock_timestamp())
        AND (o.sweep_skip_until IS NULL OR o.sweep_skip_until <= clock_timestamp())
      ORDER BY o.id LIMIT 500
  LOOP
    BEGIN
      IF app.ledger_lock_target(r.ows, r.oid, r.was, r.tok) THEN
        entered := CASE WHEN r.spent THEN 'failed' ELSE 'retry_wait' END;
        UPDATE app.operations AS o SET state = entered, last_actor = CASE WHEN r.spent THEN 'S' ELSE 'X' END,
            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, processing_deadline = NULL,
            next_attempt_at = CASE WHEN r.spent THEN o.next_attempt_at ELSE clock_timestamp() END
          WHERE o.workspace_id = r.ows AND o.id = r.oid;
        INSERT INTO app.outbox (workspace_id, type, payload)
          VALUES (r.ows, 'operation.' || entered, jsonb_build_object('operation_id', r.oid, 'from', r.was, 'to', entered));
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

-- The guard of every operation write. A move from processing to retry_wait, whoever makes it, counts as an attempt.
CREATE OR REPLACE FUNCTION app.ledger_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  resend text := current_setting('app.idempotent_resend', true);
  taken boolean;
  bumps boolean;
  resets integer[];
  last_try record;
  found_try boolean;
  absent boolean;
  attested boolean;
  proven boolean;
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.effect <> 'none' OR NEW.fencing_token <> 0) THEN
    RAISE EXCEPTION 'ledger_guard: an operation starts with no effect and token 0' USING ERRCODE = 'SH409';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.state = OLD.state THEN
    IF (OLD.effect <> 'none' AND NEW.effect = 'none') OR NEW.fencing_token < OLD.fencing_token THEN
      RAISE EXCEPTION 'ledger_guard: an effect or a token cannot go back without a move' USING ERRCODE = 'SH409';
    END IF;
    IF NEW.fencing_token <> OLD.fencing_token
       AND NOT (NEW.fencing_token = OLD.fencing_token + 1 AND prior IN ('claim_polls', 'sweep_expired_leases')) THEN
      RAISE EXCEPTION 'ledger_guard: the token rises by one, in a poll claim or a lease sweep only' USING ERRCODE = 'SH409';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM set_config('app.job_purpose', 'ledger_guard', true);
  SELECT count(*) > 0, coalesce(bool_or(t.bumps_fence), false),
      coalesce(array_agg(t.row_no) FILTER (WHERE t.row_no IN (19, 20, 21, 24, 36, 42, 44)), ARRAY[]::integer[])
    INTO taken, bumps, resets
    FROM app.ledger_transitions AS t
    WHERE t.from_state = CASE WHEN TG_OP = 'INSERT' THEN 'none' ELSE OLD.state END
      AND t.to_state = NEW.state AND t.actor = NEW.last_actor;
  IF NOT taken THEN
    RAISE EXCEPTION 'ledger_guard: this move is not in the transition table' USING ERRCODE = 'SH409';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.effect <> 'none' AND NEW.effect = 'none' THEN
    IF cardinality(resets) = 0 THEN
      RAISE EXCEPTION 'ledger_guard: an effect that may have happened is not reset by this move' USING ERRCODE = 'SH409';
    END IF;
    SELECT a.effect, a.finished_at, a.started_at INTO last_try FROM app.operation_attempts AS a
      WHERE a.workspace_id = OLD.workspace_id AND a.operation_id = OLD.id ORDER BY a.attempt_no DESC LIMIT 1;
    found_try := FOUND;
    absent := EXISTS (SELECT 1 FROM app.operation_evidence AS e
      WHERE e.workspace_id = OLD.workspace_id AND e.operation_id = OLD.id AND e.kind = 'absent'
        AND (NOT found_try OR e.observed_at > last_try.started_at));
    attested := EXISTS (SELECT 1 FROM app.operation_evidence AS e
      WHERE e.workspace_id = OLD.workspace_id AND e.operation_id = OLD.id AND e.level = 'human'
        AND e.kind = 'human_confirmed' AND (NOT found_try OR e.observed_at > last_try.started_at));
    proven := CASE
      WHEN resets && ARRAY[19, 20, 21] THEN found_try AND last_try.effect = 'none' AND last_try.finished_at IS NOT NULL
      WHEN 24 = ANY (resets) THEN absent
      WHEN 36 = ANY (resets) THEN absent OR resend = 'true'
      ELSE absent OR attested END;
    IF NOT coalesce(proven, false) THEN
      RAISE EXCEPTION 'ledger_guard: an effect is not reset without proof that nothing was sent' USING ERRCODE = 'SH409';
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.effect <> 'none' AND NEW.state IN ('retry_wait', 'failed', 'paused', 'cancelled') THEN
    RAISE EXCEPTION 'ledger_guard: a move into % leaves no effect, so the proof must reset it', NEW.state
      USING ERRCODE = 'SH409';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.fencing_token := OLD.fencing_token + CASE WHEN bumps THEN 1 ELSE 0 END;
    IF OLD.state = 'processing' AND NEW.state = 'retry_wait' THEN
      NEW.attempt_count := OLD.attempt_count + 1;
    END IF;
  END IF;
  IF NEW.state IN ('published', 'provider_accepted') THEN
    NEW.effect := 'confirmed';
  END IF;
  IF NEW.state IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome') THEN
    NEW.settled_at := clock_timestamp();
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.state IN ('needs_human', 'unverified') THEN
    NEW.next_escalation_at := clock_timestamp();
  END IF;
  NEW.updated_at := clock_timestamp();
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEW;
END
$$;

-- With `p_poll_in` the row must be processing: the next check is that many seconds ahead and the lease ends.
CREATE FUNCTION app.operation_record_progress(
  p_ws uuid, p_op uuid, p_token bigint, p_cursor text, p_refs jsonb, p_poll_in integer DEFAULT NULL)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM app.ledger_caller();
  IF NOT coalesce(p_ws = ANY (app.ws_ids()), false) THEN
    RAISE EXCEPTION 'ledger: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.job_purpose', 'operation_record_progress', true);
  IF (p_refs IS NOT NULL AND (jsonb_typeof(p_refs) IS DISTINCT FROM 'object' OR octet_length(p_refs::text) > 65536))
     OR (p_cursor IS NOT NULL AND p_cursor !~ '^(prepare:[0-9]{1,3}|await_processing|commit|done)$')
     OR (p_poll_in IS NOT NULL AND p_poll_in NOT BETWEEN 1 AND 86400) THEN
    RAISE EXCEPTION 'operation_record_progress: the references are an object of at most 64 KiB, the cursor a step and the poll delay 1 to 86400 seconds'
      USING ERRCODE = '22023';
  END IF;
  UPDATE app.operations AS o SET step_cursor = coalesce(p_cursor, o.step_cursor), provider_refs = coalesce(p_refs, o.provider_refs),
      next_check_at = CASE WHEN p_poll_in IS NULL THEN o.next_check_at
        ELSE clock_timestamp() + make_interval(secs => p_poll_in) END,
      lease_owner = CASE WHEN p_poll_in IS NULL THEN o.lease_owner END,
      lease_expires_at = CASE WHEN p_poll_in IS NULL THEN o.lease_expires_at END,
      heartbeat_at = CASE WHEN p_poll_in IS NULL THEN o.heartbeat_at END
    WHERE o.workspace_id = p_ws AND o.id = p_op AND o.fencing_token = p_token
      AND o.state IN ('claimed', 'processing', 'dispatching') AND (p_poll_in IS NULL OR o.state = 'processing')
      AND o.lease_expires_at > clock_timestamp();
  outcome := CASE WHEN FOUND THEN 'recorded' ELSE 'lost_lease' END;
  PERFORM set_config('app.job_purpose', 'ledger', true);
  RETURN NEXT;
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
        last_actor = CASE r.state WHEN 'claimed' THEN 'W' ELSE 'P' END, processing_deadline = NULL
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

REVOKE ALL ON FUNCTION app.sweep_due_moves(jsonb), app.operation_record_progress(uuid, uuid, bigint, text, jsonb, integer),
  app.operation_attempt_start(uuid, uuid, bigint, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sweep_due_moves(jsonb),
  app.operation_record_progress(uuid, uuid, bigint, text, jsonb, integer),
  app.operation_attempt_start(uuid, uuid, bigint, text, text, jsonb) TO shoutory_worker;
RESET ROLE;
