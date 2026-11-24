GRANT INSERT ON app.usage_reservations TO shoutory_definer;
GRANT UPDATE (schedule_state) ON app.post_variants TO shoutory_definer;
-- The worker reads no secret and no display column of a channel.
GRANT SELECT (id, workspace_id, provider_id, provider_account_id, instance_host, connection_state, capability_epoch)
  ON app.channels TO shoutory_worker;

-- The target row and the channel row are locked, so the SELECT policy comes with the UPDATE one.
CALL app.grant_purposes('post_variants', 'SELECT', ARRAY['admit_due_targets']);
CALL app.grant_purposes('post_variants', 'UPDATE', ARRAY['admit_due_targets']);
CALL app.grant_purposes('posts', 'SELECT', ARRAY['admit_due_targets']);
CALL app.grant_purposes('post_versions', 'SELECT', ARRAY['admit_due_targets']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['admit_due_targets']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['admit_due_targets']);
CALL app.grant_purposes('channels', 'UPDATE', ARRAY['admit_due_targets']);
CALL app.grant_purposes('usage_reservations', 'INSERT', ARRAY['admit_due_targets']);

ALTER TABLE app.rate_buckets ADD COLUMN paused_until timestamptz;
ALTER TABLE app.rate_buckets ADD COLUMN pause_reason text;
-- shoutory:accepted-lock a small throttle table whose rows are removed after 30 days; the new column is empty, so the scan is brief
ALTER TABLE app.rate_buckets ADD CONSTRAINT rate_buckets_pause_reason_check
  CHECK (pause_reason IS NULL OR char_length(pause_reason) BETWEEN 1 AND 64);
CALL app.grant_purposes('rate_buckets', 'SELECT', ARRAY['bucket_take_scoped', 'bucket_pause']);
CALL app.grant_purposes('rate_buckets', 'INSERT', ARRAY['bucket_take_scoped', 'bucket_pause']);
CALL app.grant_purposes('rate_buckets', 'UPDATE', ARRAY['bucket_take_scoped', 'bucket_pause']);

-- A row lock needs the SELECT policy as well as the UPDATE one.
CALL app.grant_purposes('operations', 'SELECT', ARRAY['claim_operations', 'ledger_heartbeat', 'claim_polls',
  'claim_reconciles', 'sweep_expired_leases', 'sweep_due_moves']);
CALL app.grant_purposes('operations', 'UPDATE', ARRAY['claim_operations', 'ledger_heartbeat', 'claim_polls',
  'claim_reconciles', 'sweep_expired_leases', 'sweep_due_moves']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['sweep_due_moves']);
-- A poll claim raises the token without a state change, so the definer may write it; the guard below allows that only
-- in the two jobs that do it.
GRANT UPDATE (fencing_token) ON app.operations TO shoutory_definer;

SET ROLE shoutory_definer;

-- The outbox belongs to the definer, so its insert policies are created here.
CREATE POLICY admit_due_targets_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'admit_due_targets');
CREATE POLICY claim_operations_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'claim_operations');
CREATE POLICY claim_reconciles_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'claim_reconciles');
CREATE POLICY sweep_expired_leases_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'sweep_expired_leases');
CREATE POLICY sweep_due_moves_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'sweep_due_moves');

-- A same-state change may raise the token by exactly one, and only under the poll claim or the lease sweep purpose;
-- any other token change is refused. The caller's purpose is read at entry, before the guard sets its own.
CREATE OR REPLACE FUNCTION app.ledger_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  taken boolean;
  bumps boolean;
  resets boolean;
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
  SELECT count(*) > 0, coalesce(bool_or(t.bumps_fence), false), coalesce(bool_or(t.row_no IN (19, 20, 21, 24, 36, 42, 44)), false)
    INTO taken, bumps, resets
    FROM app.ledger_transitions AS t
    WHERE t.from_state = CASE WHEN TG_OP = 'INSERT' THEN 'none' ELSE OLD.state END
      AND t.to_state = NEW.state AND t.actor = NEW.last_actor;
  IF NOT taken THEN
    RAISE EXCEPTION 'ledger_guard: this move is not in the transition table' USING ERRCODE = 'SH409';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.effect <> 'none' AND NEW.effect = 'none' AND NOT resets THEN
    RAISE EXCEPTION 'ledger_guard: an effect that may have happened is not reset by this move' USING ERRCODE = 'SH409';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.fencing_token := OLD.fencing_token + CASE WHEN bumps THEN 1 ELSE 0 END;
  END IF;
  IF NEW.state IN ('published', 'provider_accepted') THEN
    NEW.effect := 'confirmed';
  END IF;
  IF NEW.state IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome') THEN
    NEW.settled_at := clock_timestamp();
  END IF;
  NEW.updated_at := clock_timestamp();
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEW;
END
$$;

-- Reads the purpose the caller set, so every definer calls it before setting its own. Every other principal or
-- purpose gets the same refusal.
CREATE FUNCTION app.ledger_caller()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'job' OR app.job_purpose() IS DISTINCT FROM 'ledger' THEN
    RAISE EXCEPTION 'ledger: refused' USING ERRCODE = '42501';
  END IF;
END
$$;

-- The margin lets admission run early; the operation is never due before the target's own time. The target is taken
-- with FOR UPDATE SKIP LOCKED, then its channel FOR SHARE, as the fenced move does: two callers never admit one
-- target, and never wait on each other's channels (writers that hold a channel FOR UPDATE take no target after it).
-- A target the target index or the settled guard refuses is skipped and the others go on; any other fault ends the
-- call. The target leaves `scheduled` in every case, so the next tick does not meet it again.
CREATE FUNCTION app.admit_due_targets(p_limit integer, p_providers jsonb)
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
  FOR r IN
    SELECT v.id AS variant_id, v.workspace_id AS ws, v.channel_id, v.due_at, v.frozen_version_id, c.provider_id,
        p.author_id
      FROM app.post_variants AS v
      JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      WHERE v.schedule_state = 'scheduled' AND v.due_at IS NOT NULL AND p.deleted_at IS NULL AND p.status <> 'archived'
        AND jsonb_exists(p_providers, c.provider_id)
        AND v.due_at <= clock_timestamp() + make_interval(secs => (p_providers -> c.provider_id ->> 'margin_seconds')::float8)
      ORDER BY v.due_at, v.id LIMIT p_limit FOR UPDATE OF v SKIP LOCKED
  LOOP
    added := false;
    BEGIN
      SELECT c.connection_state INTO ch FROM app.channels AS c WHERE c.workspace_id = r.ws AND c.id = r.channel_id FOR SHARE;
      SELECT w.lateness_tolerance, w.organization_id INTO tolerance, org FROM app.workspaces AS w WHERE w.id = r.ws;
      IF clock_timestamp() > r.due_at + tolerance THEN
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
        INSERT INTO app.usage_reservations (workspace_id, organization_id, operation_id, key, amount)
          VALUES (r.ws, org, new_op, 'posts_per_month', 1);
      END IF;
      UPDATE app.post_variants AS v SET schedule_state = CASE WHEN st = 'blocked_reconnect' THEN 'held' ELSE 'in_progress' END
        WHERE v.workspace_id = r.ws AND v.id = r.variant_id;
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
    END;
    IF added THEN
      operation_id := new_op; workspace_id := r.ws; queue := 'publish.' || r.provider_id; state := st;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
END
$$;

-- SKIP LOCKED keeps two workers from claiming one row. The lease is measured on the database clock; 60 seconds when
-- the row carries no length.
CREATE FUNCTION app.claim_operations(p_queue text, p_limit integer, p_owner text)
RETURNS TABLE (id uuid, workspace_id uuid, fencing_token bigint, lease_expires_at timestamptz, kind text, state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'claim_operations', true);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_queue IS NULL OR p_owner IS NULL
     OR char_length(p_owner) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'claim_operations: the limit is 1 to 500, the queue and the owner are named' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.lease_seconds AS secs FROM app.operations AS o
      WHERE o.state = 'pending' AND o.queue = p_queue AND o.next_attempt_at <= clock_timestamp()
        AND clock_timestamp() <= o.lateness_deadline + o.blocked_total
      ORDER BY o.next_attempt_at, o.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE app.operations AS o SET state = 'claimed', last_actor = 'W', lease_owner = p_owner,
        lease_expires_at = clock_timestamp() + make_interval(secs => coalesce(r.secs, 60)), heartbeat_at = clock_timestamp()
      WHERE o.workspace_id = r.ows AND o.id = r.oid
      RETURNING o.id, o.workspace_id, o.fencing_token, o.lease_expires_at, o.kind, o.state
      INTO id, workspace_id, fencing_token, lease_expires_at, kind, state;
    INSERT INTO app.outbox (workspace_id, type, payload)
      VALUES (r.ows, 'operation.claimed', jsonb_build_object('operation_id', r.oid, 'from', 'pending', 'to', 'claimed'));
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
END
$$;

CREATE FUNCTION app.heartbeat(p_id uuid, p_token bigint, p_owner text, p_extend_seconds integer)
RETURNS TABLE (outcome text, lease_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'ledger_heartbeat', true);
  IF p_extend_seconds IS NULL OR p_extend_seconds NOT BETWEEN 1 AND 3600 OR p_owner IS NULL
     OR char_length(p_owner) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'heartbeat: the extension is 1 to 3600 seconds and the owner is named' USING ERRCODE = '22023';
  END IF;
  UPDATE app.operations AS o SET lease_expires_at = clock_timestamp() + make_interval(secs => p_extend_seconds),
      heartbeat_at = clock_timestamp()
    WHERE o.id = p_id AND o.fencing_token = p_token AND o.lease_owner = p_owner AND o.lease_expires_at > clock_timestamp()
    RETURNING o.lease_expires_at INTO lease_expires_at;
  outcome := CASE WHEN FOUND THEN 'ok' ELSE 'lost' END;
  PERFORM set_config('app.job_purpose', 'ledger', true);
  RETURN NEXT;
END
$$;

-- The state does not change; the token rises by one, so a poller that held the earlier lease is fenced out.
CREATE FUNCTION app.claim_polls(p_queue text, p_limit integer, p_owner text, p_lease_seconds integer)
RETURNS TABLE (id uuid, workspace_id uuid, fencing_token bigint, lease_expires_at timestamptz, kind text, state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'claim_polls', true);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_queue IS NULL OR p_owner IS NULL
     OR char_length(p_owner) NOT BETWEEN 1 AND 128
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'claim_polls: the limit is 1 to 500, the lease 1 to 3600 seconds' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows FROM app.operations AS o
      WHERE o.state IN ('processing', 'provider_accepted') AND o.queue = p_queue AND o.next_check_at <= clock_timestamp()
        AND (o.lease_owner IS NULL OR o.lease_expires_at <= clock_timestamp())
      ORDER BY o.next_check_at, o.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE app.operations AS o SET fencing_token = o.fencing_token + 1, last_actor = 'P', lease_owner = p_owner,
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds), heartbeat_at = clock_timestamp()
      WHERE o.workspace_id = r.ows AND o.id = r.oid
      RETURNING o.id, o.workspace_id, o.fencing_token, o.lease_expires_at, o.kind, o.state
      INTO id, workspace_id, fencing_token, lease_expires_at, kind, state;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
END
$$;

-- A kind in `p_class_e_kinds` (its provider cannot read the outcome back) goes straight to `needs_human` and is never
-- leased or resent.
CREATE FUNCTION app.claim_reconciles(p_queue text, p_limit integer, p_owner text, p_lease_seconds integer,
  p_class_e_kinds text[])
RETURNS TABLE (id uuid, workspace_id uuid, fencing_token bigint, lease_expires_at timestamptz, kind text, state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'claim_reconciles', true);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_queue IS NULL OR p_owner IS NULL
     OR char_length(p_owner) NOT BETWEEN 1 AND 128
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'claim_reconciles: the limit is 1 to 500, the lease 1 to 3600 seconds' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.kind = ANY (coalesce(p_class_e_kinds, ARRAY[]::text[])) AS human
      FROM app.operations AS o
      WHERE o.state = 'unknown_external_state' AND o.queue = p_queue AND o.next_check_at <= clock_timestamp()
      ORDER BY o.next_check_at, o.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE app.operations AS o SET state = CASE WHEN r.human THEN 'needs_human' ELSE 'reconciling' END, last_actor = 'R',
        lease_owner = CASE WHEN r.human THEN NULL ELSE p_owner END,
        lease_expires_at = CASE WHEN r.human THEN NULL ELSE clock_timestamp() + make_interval(secs => p_lease_seconds) END,
        heartbeat_at = CASE WHEN r.human THEN NULL ELSE clock_timestamp() END
      WHERE o.workspace_id = r.ows AND o.id = r.oid
      RETURNING o.id, o.workspace_id, o.fencing_token, o.lease_expires_at, o.kind, o.state
      INTO id, workspace_id, fencing_token, lease_expires_at, kind, state;
    INSERT INTO app.outbox (workspace_id, type, payload)
      VALUES (r.ows, 'operation.' || state,
        jsonb_build_object('operation_id', r.oid, 'from', 'unknown_external_state', 'to', state));
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
END
$$;

-- One row at a time, so the guard's refusal of one row leaves the others moved. Every move raises the token, fencing
-- out the holder of the dead lease. `dispatching` and `reconciling` go to `unknown_external_state`, never `pending`:
-- the call may have been sent, so it must never be resent.
CREATE FUNCTION app.sweep_expired_leases()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
  moved integer := 0;
  entered text;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'sweep_expired_leases', true);
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was FROM app.operations AS o
      WHERE o.lease_expires_at IS NOT NULL AND o.lease_expires_at < clock_timestamp()
        AND o.state IN ('claimed', 'dispatching', 'reconciling', 'processing', 'provider_accepted')
      ORDER BY o.lease_expires_at, o.id LIMIT 500 FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      IF r.was IN ('processing', 'provider_accepted') THEN
        UPDATE app.operations AS o SET fencing_token = o.fencing_token + 1, last_actor = 'X', lease_owner = NULL,
            lease_expires_at = NULL, heartbeat_at = NULL
          WHERE o.workspace_id = r.ows AND o.id = r.oid;
      ELSE
        entered := CASE WHEN r.was = 'claimed' THEN 'pending' ELSE 'unknown_external_state' END;
        UPDATE app.operations AS o SET state = entered, last_actor = 'X', lease_owner = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL, queue = CASE WHEN r.was = 'claimed' THEN o.queue ELSE 'reconcile.' || o.provider_id END,
            next_check_at = CASE WHEN r.was = 'claimed' THEN o.next_check_at ELSE clock_timestamp() END
          WHERE o.workspace_id = r.ows AND o.id = r.oid;
        INSERT INTO app.outbox (workspace_id, type, payload)
          VALUES (r.ows, 'operation.' || entered, jsonb_build_object('operation_id', r.oid, 'from', r.was, 'to', entered));
      END IF;
      moved := moved + 1;
    EXCEPTION WHEN SQLSTATE 'SH409' THEN
      NULL;
    END;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
  RETURN moved;
END
$$;

-- Not an entry point. A retried row goes back on its publish queue because a read-back may have moved it to the
-- reconcile one.
CREATE FUNCTION app.ledger_due_move(p_ws uuid, p_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  was text;
  entered text;
BEGIN
  SELECT o.state INTO was FROM app.operations AS o WHERE o.workspace_id = p_ws AND o.id = p_id;
  UPDATE app.operations AS o SET
      state = CASE WHEN o.effect = 'none' AND clock_timestamp() > o.lateness_deadline + o.blocked_total
        THEN 'missed' ELSE 'pending' END,
      last_actor = 'S', reason_code = NULL,
      queue = CASE WHEN o.state = 'retry_wait' THEN 'publish.' || o.provider_id ELSE o.queue END
    WHERE o.workspace_id = p_ws AND o.id = p_id
    RETURNING o.state INTO entered;
  INSERT INTO app.outbox (workspace_id, type, payload)
    VALUES (p_ws, 'operation.' || entered, jsonb_build_object('operation_id', p_id, 'from', was, 'to', entered));
END
$$;

-- One row at a time, so the guard's refusal of one row leaves the others moved. Only two pauses end here: a provider
-- cooldown whose time came, and a disabled channel that is connected again. A row that is both due and late is missed.
CREATE FUNCTION app.sweep_due_moves()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
  moved integer := 0;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'sweep_due_moves', true);
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows FROM app.channels AS c
      JOIN app.operations AS o ON o.workspace_id = c.workspace_id AND o.channel_id = c.id
      WHERE c.connection_state = 'connected' AND o.state = 'paused' AND o.reason_code = 'channel_disabled'
      ORDER BY o.id LIMIT 500 FOR UPDATE OF o SKIP LOCKED
  LOOP
    BEGIN
      PERFORM app.ledger_due_move(r.ows, r.oid);
      moved := moved + 1;
    EXCEPTION WHEN SQLSTATE 'SH409' THEN
      NULL;
    END;
  END LOOP;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows FROM app.operations AS o
      WHERE o.state IN ('pending', 'retry_wait', 'paused')
        AND ((o.effect = 'none' AND clock_timestamp() > o.lateness_deadline + o.blocked_total)
          OR (o.state = 'retry_wait' AND o.next_attempt_at <= clock_timestamp())
          OR (o.state = 'paused' AND o.reason_code = 'provider_cooldown' AND o.next_attempt_at <= clock_timestamp()))
      ORDER BY o.id LIMIT 500 FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM app.ledger_due_move(r.ows, r.oid);
      moved := moved + 1;
    EXCEPTION WHEN SQLSTATE 'SH409' THEN
      NULL;
    END;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
  RETURN moved;
END
$$;

-- Like bucket_take, but the capacity and the full-refill window come from the caller, not a lookup. A paused bucket
-- refuses a spend until its pause ends and answers the rest of the pause as the wait.
CREATE FUNCTION app.bucket_take_scoped(
  p_key text, p_scope text, p_capacity integer, p_window_seconds integer, p_cost integer DEFAULT 1)
RETURNS TABLE (allowed boolean, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  have double precision;
  found_row boolean;
  paused timestamptz;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'bucket_take_scoped', true);
  IF NOT coalesce(p_scope IN ('account', 'chat', 'webhook', 'instance', 'app') AND p_key ~ '^[0-9a-f]{64}$'
      AND p_capacity BETWEEN 1 AND 10000 AND p_window_seconds BETWEEN 1 AND 86400
      AND (p_cost = 1 OR p_cost BETWEEN -p_capacity AND -1), false) THEN
    RAISE EXCEPTION 'bucket_take_scoped refuses this scope, key, capacity, window or cost' USING ERRCODE = '22023';
  END IF;
  IF p_cost = 1 THEN
    INSERT INTO app.rate_buckets (scope, key, tokens) VALUES (p_scope, p_key, p_capacity)
      ON CONFLICT ON CONSTRAINT rate_buckets_pkey DO NOTHING;
  END IF;
  SELECT least(p_capacity, b.tokens + greatest(0, extract(epoch FROM clock_timestamp() - b.refilled_at)) * p_capacity / p_window_seconds),
      true, b.paused_until
    INTO have, found_row, paused
    FROM app.rate_buckets AS b WHERE b.scope = p_scope AND b.key = p_key FOR UPDATE;
  IF NOT coalesce(found_row, false) THEN
    allowed := true; remaining := p_capacity; retry_after_seconds := 0;
  ELSIF p_cost = 1 AND paused > clock_timestamp() THEN
    allowed := false; remaining := floor(have)::integer;
    retry_after_seconds := ceil(extract(epoch FROM paused - clock_timestamp()))::integer;
  ELSE
    allowed := have >= 1 OR p_cost < 0;
    IF allowed THEN have := least(p_capacity, have - p_cost); END IF;
    UPDATE app.rate_buckets AS b SET tokens = have, refilled_at = clock_timestamp()
      WHERE b.scope = p_scope AND b.key = p_key;
    remaining := floor(have)::integer;
    retry_after_seconds := CASE WHEN allowed THEN 0
      ELSE ceil((1 - have) * p_window_seconds / p_capacity)::integer END;
  END IF;
  PERFORM set_config('app.job_purpose', 'ledger', true);
  RETURN NEXT;
END
$$;

-- For a provider's Retry-After. A later pause never shortens an earlier one. A missing bucket is created with infinite
-- tokens, which the next take caps at its capacity.
CREATE FUNCTION app.bucket_pause(p_key text, p_scope text, p_until timestamptz, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'bucket_pause', true);
  IF NOT coalesce(p_scope IN ('account', 'chat', 'webhook', 'instance', 'app') AND p_key ~ '^[0-9a-f]{64}$'
      AND p_until <= clock_timestamp() + interval '24 hours' AND char_length(p_reason) BETWEEN 1 AND 64, false) THEN
    RAISE EXCEPTION 'bucket_pause refuses this scope, key, end or reason' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.rate_buckets (scope, key, tokens, paused_until, pause_reason)
    VALUES (p_scope, p_key, 'Infinity'::double precision, p_until, p_reason)
    ON CONFLICT ON CONSTRAINT rate_buckets_pkey DO UPDATE SET
      pause_reason = CASE WHEN rate_buckets.paused_until IS NULL OR EXCLUDED.paused_until >= rate_buckets.paused_until
        THEN EXCLUDED.pause_reason ELSE rate_buckets.pause_reason END,
      paused_until = greatest(coalesce(rate_buckets.paused_until, EXCLUDED.paused_until), EXCLUDED.paused_until);
  PERFORM set_config('app.job_purpose', 'ledger', true);
END
$$;

REVOKE ALL ON FUNCTION app.ledger_caller(), app.admit_due_targets(integer, jsonb),
  app.claim_operations(text, integer, text), app.heartbeat(uuid, bigint, text, integer),
  app.claim_polls(text, integer, text, integer), app.claim_reconciles(text, integer, text, integer, text[]),
  app.sweep_expired_leases(), app.ledger_due_move(uuid, uuid), app.sweep_due_moves(),
  app.bucket_take_scoped(text, text, integer, integer, integer), app.bucket_pause(text, text, timestamptz, text),
  app.ledger_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admit_due_targets(integer, jsonb), app.claim_operations(text, integer, text),
  app.heartbeat(uuid, bigint, text, integer), app.claim_polls(text, integer, text, integer),
  app.claim_reconciles(text, integer, text, integer, text[]), app.sweep_expired_leases(), app.sweep_due_moves(),
  app.bucket_take_scoped(text, text, integer, integer, integer), app.bucket_pause(text, text, timestamptz, text)
  TO shoutory_worker;
RESET ROLE;
