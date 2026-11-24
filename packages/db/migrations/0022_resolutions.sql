-- The guard sets the token, the settled time, the update time and the escalation time itself.
GRANT SELECT ON app.operation_evidence TO shoutory_definer;
GRANT INSERT ON app.operation_attempts, app.operation_resolutions TO shoutory_definer;
GRANT UPDATE (effect, finished_at, request_fingerprint, http_status, error_class, provider_code, retry_after_ms,
  response_excerpt) ON app.operation_attempts TO shoutory_definer;
GRANT UPDATE (attempt_count, unverified_until, superseded_by_operation_id, lateness_deadline) ON app.operations
  TO shoutory_definer;
GRANT UPDATE (state) ON app.usage_reservations TO shoutory_definer;
GRANT UPDATE (status, targets_total, targets_published, targets_published_not_live, published_at) ON app.posts
  TO shoutory_definer;
GRANT UPDATE (published_at, external_id, permalink, presence, updated_at) ON app.post_variants TO shoutory_definer;
COMMENT ON TABLE app.operation_attempts IS 'The calls the ledger made for an operation: a start row and one finish update.';

-- Refunded when an attempt is shown to have had no effect, so a retry reserves again. Only the definers read or write
-- it. A refunded row no longer counts in the window index.
CREATE TABLE app.provider_quota_ledger (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid,
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 64),
  provider_account_id text NOT NULL CHECK (char_length(provider_account_id) BETWEEN 1 AND 255),
  quota_key text NOT NULL CHECK (char_length(quota_key) BETWEEN 1 AND 64),
  operation_id uuid NOT NULL REFERENCES app.operations (id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES app.operation_attempts (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'booked', 'refunded')),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_quota_ledger_attempt_key UNIQUE (attempt_id, quota_key)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX provider_quota_ledger_window_idx ON app.provider_quota_ledger (provider_id, provider_account_id, quota_key, at)
  WHERE state <> 'refunded';
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX provider_quota_ledger_operation_idx ON app.provider_quota_ledger (operation_id);
SELECT app.apply_rls_template('app.provider_quota_ledger'::regclass, 'D');
GRANT SELECT, INSERT, DELETE ON app.provider_quota_ledger TO shoutory_definer;
GRANT UPDATE (state) ON app.provider_quota_ledger TO shoutory_definer;

-- The seed policy exists only for this insert.
CREATE POLICY retention_seed_insert ON app.retention_classes FOR INSERT TO shoutory_owner WITH CHECK (true);
INSERT INTO app.retention_classes (class, table_name, kind, event_column, retain, partition_unit) VALUES
  ('app.provider_quota_ledger', 'app.provider_quota_ledger', 'window', 'at', interval '7 days', NULL);
DROP POLICY retention_seed_insert ON app.retention_classes;
CALL app.grant_purposes('provider_quota_ledger', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('provider_quota_ledger', 'DELETE', ARRAY['purge_expired']);

-- Each function lists only what it touches; a row lock needs the SELECT policy as well as the UPDATE one.
CALL app.grant_purposes('operations', 'SELECT', ARRAY['ledger_prelock', 'operation_rollup', 'operation_attempt_start',
  'operation_attempt_finish', 'operation_record_progress', 'resolve_operation', 'ledger_state_counts']);
CALL app.grant_purposes('operations', 'UPDATE', ARRAY['ledger_prelock', 'operation_attempt_start',
  'operation_record_progress', 'resolve_operation']);
CALL app.grant_purposes('posts', 'SELECT', ARRAY['ledger_prelock', 'operation_rollup', 'resolve_operation']);
CALL app.grant_purposes('posts', 'UPDATE', ARRAY['ledger_prelock', 'operation_rollup', 'resolve_operation',
  'admit_due_targets']);
CALL app.grant_purposes('post_variants', 'SELECT', ARRAY['ledger_prelock', 'operation_rollup', 'resolve_operation']);
CALL app.grant_purposes('post_variants', 'UPDATE', ARRAY['ledger_prelock', 'operation_rollup', 'resolve_operation']);
CALL app.grant_purposes('operation_evidence', 'SELECT', ARRAY['ledger_guard', 'operation_rollup', 'resolve_operation']);
CALL app.grant_purposes('operation_evidence', 'INSERT', ARRAY['resolve_operation']);
CALL app.grant_purposes('operation_attempts', 'SELECT', ARRAY['ledger_guard', 'operation_attempt_start',
  'operation_attempt_finish', 'resolve_operation']);
CALL app.grant_purposes('operation_attempts', 'INSERT', ARRAY['operation_attempt_start']);
CALL app.grant_purposes('operation_attempts', 'UPDATE', ARRAY['operation_attempt_finish']);
CALL app.grant_purposes('operation_resolutions', 'INSERT', ARRAY['resolve_operation']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['operation_attempt_start', 'resolve_operation']);
-- FOR SHARE on the channel needs the UPDATE policy as well.
CALL app.grant_purposes('channels', 'UPDATE', ARRAY['resolve_operation']);
CALL app.grant_purposes('rate_buckets', 'SELECT', ARRAY['operation_attempt_start']);
CALL app.grant_purposes('rate_buckets', 'INSERT', ARRAY['operation_attempt_start']);
CALL app.grant_purposes('rate_buckets', 'UPDATE', ARRAY['operation_attempt_start']);
CALL app.grant_purposes('provider_quota_ledger', 'SELECT', ARRAY['operation_attempt_start', 'operation_usage']);
CALL app.grant_purposes('provider_quota_ledger', 'INSERT', ARRAY['operation_attempt_start']);
CALL app.grant_purposes('provider_quota_ledger', 'UPDATE', ARRAY['operation_usage']);
CALL app.grant_purposes('usage_reservations', 'SELECT', ARRAY['operation_usage']);
CALL app.grant_purposes('usage_reservations', 'UPDATE', ARRAY['operation_usage']);
CALL app.grant_purposes('usage_reservations', 'INSERT', ARRAY['resolve_operation']);
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['resolve_operation']);
  END LOOP;
END
$$;

-- The definer creates the triggers, so it needs TRIGGER on the table until they exist.
GRANT TRIGGER ON app.operations TO shoutory_definer;
SET ROLE shoutory_definer;

CREATE POLICY operation_attempt_start_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'operation_attempt_start');
CREATE POLICY resolve_operation_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'resolve_operation');

-- Locks the post, then the target, before the caller locks the operation: the rollup and usage triggers write the post
-- and target after the operation update, so the locks must come first. Not an entry point.
CREATE FUNCTION app.ledger_prelock(p_ws uuid, p_op uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  pid uuid;
  vid uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'ledger_prelock', true);
  SELECT v.post_id, o.variant_id INTO pid, vid FROM app.operations AS o
    JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
    WHERE o.workspace_id = p_ws AND o.id = p_op;
  IF FOUND THEN
    PERFORM 1 FROM app.posts AS p WHERE p.workspace_id = p_ws AND p.id = pid FOR NO KEY UPDATE;
    PERFORM 1 FROM app.post_variants AS v WHERE v.workspace_id = p_ws AND v.id = vid FOR NO KEY UPDATE;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The same locks for a sweep, skipped when any is held because a sweep never waits. The row is locked only if it still
-- has the state and token the sweep read.
CREATE FUNCTION app.ledger_lock_target(p_ws uuid, p_op uuid, p_state text, p_token bigint)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  held boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'ledger_prelock', true);
  PERFORM 1 FROM app.posts AS p
    JOIN app.post_variants AS v ON v.workspace_id = p.workspace_id AND v.post_id = p.id
    JOIN app.operations AS o ON o.workspace_id = v.workspace_id AND o.variant_id = v.id
    WHERE o.workspace_id = p_ws AND o.id = p_op AND o.state = p_state AND o.fencing_token = p_token
    FOR NO KEY UPDATE OF p, v, o SKIP LOCKED;
  held := FOUND;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN held;
END
$$;

-- Only operations of kind publish count.
CREATE FUNCTION app.ledger_rollup(p_ws uuid, p_variant uuid, p_fired text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  pid uuid;
  live boolean;
  held boolean;
  sent integer;
  last_op uuid;
  ext text;
  done_at timestamptz;
  link text;
  vstate text;
  targets integer;
  pub integer;
  away integer;
  stuck boolean;
  busy boolean;
  pstatus text;
BEGIN
  PERFORM set_config('app.job_purpose', 'operation_rollup', true);
  SELECT v.post_id INTO pid FROM app.post_variants AS v WHERE v.workspace_id = p_ws AND v.id = p_variant;
  IF NOT FOUND THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN;
  END IF;
  SELECT coalesce(bool_or(o.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')), false),
      coalesce(bool_or(o.state IN ('needs_human', 'unverified', 'blocked_reconnect', 'paused')), false),
      count(*) FILTER (WHERE o.state = 'published')
    INTO live, held, sent FROM app.operations AS o
    WHERE o.workspace_id = p_ws AND o.variant_id = p_variant AND o.kind = 'publish';
  SELECT o.id, o.external_id, o.settled_at INTO last_op, ext, done_at FROM app.operations AS o
    WHERE o.workspace_id = p_ws AND o.variant_id = p_variant AND o.kind = 'publish' AND o.state = 'published'
    ORDER BY o.settled_at DESC LIMIT 1;
  SELECT e.permalink INTO link FROM app.operation_evidence AS e
    WHERE e.workspace_id = p_ws AND e.operation_id = last_op AND e.permalink IS NOT NULL
    ORDER BY e.observed_at DESC LIMIT 1;
  vstate := CASE WHEN live THEN CASE WHEN held THEN 'held' ELSE 'in_progress' END
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
      coalesce(bool_or(v.schedule_state IN ('scheduled', 'in_progress', 'approved', 'needs_approval')), false)
    INTO targets, pub, away, stuck, busy FROM app.post_variants AS v WHERE v.workspace_id = p_ws AND v.post_id = pid;
  pstatus := CASE WHEN stuck THEN 'needs_attention' WHEN busy THEN 'scheduled'
    WHEN pub > 0 AND pub = targets THEN 'published' WHEN pub > 0 THEN 'partially_published'
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

-- Claims, dispatches, retries and reconciles never touch a post.
CREATE FUNCTION app.operations_rollup()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.variant_id IS NOT NULL AND NEW.kind = 'publish' THEN
    PERFORM app.ledger_rollup(NEW.workspace_id, NEW.variant_id, NEW.state);
  END IF;
  RETURN NULL;
END
$$;

-- A row moves only from the state it must be in, so a second call changes nothing.
CREATE FUNCTION app.operations_usage()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'operation_usage', true);
  IF NEW.state IN ('provider_accepted', 'published') THEN
    UPDATE app.provider_quota_ledger AS l SET state = 'booked' WHERE l.operation_id = NEW.id AND l.state = 'reserved';
    UPDATE app.usage_reservations AS u SET state = 'booked'
      WHERE u.workspace_id = NEW.workspace_id AND u.operation_id = NEW.id AND u.state = 'reserved';
  ELSE
    IF NEW.effect = 'none' THEN
      UPDATE app.provider_quota_ledger AS l SET state = 'refunded'
        WHERE l.operation_id = NEW.id AND l.state IN ('reserved', 'booked');
    END IF;
    IF NEW.state = 'superseded_after_unknown_outcome' OR (NEW.effect = 'none' AND NEW.state IN ('failed', 'cancelled', 'missed')) THEN
      UPDATE app.usage_reservations AS u SET state = 'released'
        WHERE u.workspace_id = NEW.workspace_id AND u.operation_id = NEW.id AND u.state IN ('reserved', 'booked');
    END IF;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NULL;
END
$$;

-- The names sort these after the two guards, and they run after the row is final.
CREATE TRIGGER operations_c_rollup_insert AFTER INSERT ON app.operations
  FOR EACH ROW WHEN (NEW.state = 'missed') EXECUTE FUNCTION app.operations_rollup();
CREATE TRIGGER operations_c_rollup_update AFTER UPDATE ON app.operations
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND (NEW.state IN ('published', 'failed', 'cancelled', 'missed',
    'superseded_after_unknown_outcome', 'needs_human', 'unverified', 'blocked_reconnect', 'paused')
    OR OLD.state IN ('needs_human', 'unverified', 'blocked_reconnect', 'paused')))
  EXECUTE FUNCTION app.operations_rollup();
CREATE TRIGGER operations_d_usage AFTER UPDATE ON app.operations
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND (NEW.state IN ('provider_accepted', 'published', 'failed',
    'cancelled', 'missed', 'superseded_after_unknown_outcome') OR (OLD.effect <> 'none' AND NEW.effect = 'none')))
  EXECUTE FUNCTION app.operations_usage();

-- Proof for a move that takes an effect back to none: the no-effect retry, failure and cooldown moves need the latest
-- attempt recorded as no effect and finished; terminal failure absent and absence proven need `absent` evidence read
-- after that attempt began (absence proven also accepts the caller's resend flag, set only for the one case the core
-- rule allows); the not-executed attestation and drop need that evidence or a person's attestation. A row that cannot
-- be seen is a refusal, never a pass.
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

-- The `idempotent_resend` key is accepted only for the absence-proven move, which also puts the operation back on its
-- publish queue. The setting the guard reads is always set from this call, so a value set earlier in the transaction
-- never counts. Moves into dispatching are refused: they mark the effect with their attempt row and run only through
-- operation_attempt_start. The post and its target are locked first.
CREATE OR REPLACE FUNCTION app.operation_transition(
  workspace_id uuid, operation_id uuid, token bigint, from_state text, to_state text, actor text, changes jsonb)
RETURNS TABLE (outcome text, fencing_token bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  ev jsonb := operation_transition.changes -> 'evidence';
  want text;
  seen record;
  ch text;
  part integer;
  new_token bigint;
  landed boolean;
  resets constant boolean := (operation_transition.from_state, operation_transition.to_state, operation_transition.actor)
    IN (('dispatching', 'retry_wait', 'W'), ('dispatching', 'failed', 'W'), ('dispatching', 'paused', 'W'),
      ('provider_accepted', 'failed', 'P'), ('reconciling', 'retry_wait', 'R'));
  resend constant boolean := (operation_transition.from_state, operation_transition.to_state, operation_transition.actor)
    = ('reconciling', 'retry_wait', 'R');
BEGIN
  PERFORM set_config('app.job_purpose', 'operation_transition', true);
  PERFORM app.media_caller(operation_transition.workspace_id, 6, true);
  IF operation_transition.actor IS NULL OR operation_transition.actor NOT IN ('W', 'P', 'R') THEN
    RAISE EXCEPTION 'operation_transition: the actor is W, P or R' USING ERRCODE = '22023';
  END IF;
  IF (operation_transition.from_state, operation_transition.to_state, operation_transition.actor) IN (
      ('pending', 'claimed', 'W'), ('unknown_external_state', 'reconciling', 'R'),
      ('unknown_external_state', 'needs_human', 'R'), ('claimed', 'dispatching', 'W'),
      ('processing', 'dispatching', 'P')) THEN
    RAISE EXCEPTION 'operation_transition: this move has its own definer' USING ERRCODE = '42501';
  END IF;
  IF operation_transition.from_state IS NOT DISTINCT FROM operation_transition.to_state
     OR NOT EXISTS (SELECT 1 FROM app.ledger_transitions AS t WHERE t.from_state = operation_transition.from_state
       AND t.to_state = operation_transition.to_state AND t.actor = operation_transition.actor) THEN
    RAISE EXCEPTION 'operation_transition: this move is not in the transition table' USING ERRCODE = 'SH409';
  END IF;
  IF jsonb_typeof(operation_transition.changes) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(operation_transition.changes) AS k WHERE k <> ALL (ARRAY['reason_code',
       'next_attempt_at', 'next_check_at', 'poll_deadline', 'processing_deadline', 'step_cursor', 'provider_refs',
       'queue', 'external_id', 'evidence', 'idempotent_resend', 'unverified_horizon_days']))
     OR (jsonb_exists(operation_transition.changes, 'reason_code')
       AND operation_transition.to_state NOT IN ('paused', 'needs_human', 'provider_accepted'))
     OR (jsonb_exists(operation_transition.changes, 'idempotent_resend')
       AND (NOT resend OR jsonb_typeof(operation_transition.changes -> 'idempotent_resend') IS DISTINCT FROM 'boolean'))
     OR (jsonb_exists(operation_transition.changes, 'unverified_horizon_days')
       AND (operation_transition.to_state <> 'unknown_external_state'
         OR NOT CASE WHEN (operation_transition.changes ->> 'unverified_horizon_days') ~ '^[1-9][0-9]{0,3}$'
           THEN (operation_transition.changes ->> 'unverified_horizon_days')::integer <= 3650 ELSE false END))
     OR (ev IS NOT NULL AND operation_transition.to_state <> 'published') THEN
    RAISE EXCEPTION 'operation_transition: a change that is not allowed for this move' USING ERRCODE = '22023';
  END IF;
  want := CASE operation_transition.from_state WHEN 'dispatching' THEN 'receipt' WHEN 'provider_accepted' THEN 'poll_status'
    WHEN 'reconciling' THEN 'read_back' END;
  IF operation_transition.to_state = 'published' AND want IS NOT NULL
     AND (jsonb_typeof(ev) IS DISTINCT FROM 'object' OR ev ->> 'level' IS DISTINCT FROM want
       OR coalesce(ev ->> 'kind' NOT IN ('accepted', 'verified', 'observed'), true)
       OR coalesce(ev ->> 'outcome_kind' NOT IN ('post', 'draft_delivered'), true)) THEN
    RAISE EXCEPTION 'operation_transition: a move into published needs evidence of level %', want USING ERRCODE = '22023';
  END IF;
  PERFORM app.ledger_prelock(operation_transition.workspace_id, operation_transition.operation_id);
  IF operation_transition.to_state = 'blocked_reconnect' THEN
    SELECT o.channel_id, (o.fencing_token = operation_transition.token AND o.state = operation_transition.from_state) AS held
      INTO seen FROM app.operations AS o
      WHERE o.workspace_id = operation_transition.workspace_id AND o.id = operation_transition.operation_id;
    IF FOUND AND seen.held THEN
      SELECT c.connection_state INTO ch FROM app.channels AS c
        WHERE c.workspace_id = operation_transition.workspace_id AND c.id = seen.channel_id FOR SHARE;
      IF ch IS NULL OR ch NOT IN ('needs_reconnect', 'disconnected', 'revoked_by_provider') THEN
        RAISE EXCEPTION 'operation_transition: the channel is not blocked' USING ERRCODE = 'SH409';
      END IF;
    END IF;
  END IF;
  PERFORM set_config('app.idempotent_resend',
    CASE WHEN resend AND operation_transition.changes ->> 'idempotent_resend' = 'true' THEN 'true' ELSE 'false' END, true);
  UPDATE app.operations AS o SET
      state = operation_transition.to_state,
      last_actor = operation_transition.actor,
      effect = CASE WHEN resets THEN 'none' ELSE o.effect END,
      reason_code = CASE
        WHEN operation_transition.to_state = 'blocked_reconnect' THEN CASE operation_transition.from_state
          WHEN 'claimed' THEN 'pending' WHEN 'processing' THEN 'pending' WHEN 'provider_accepted' THEN 'provider_accepted'
          ELSE 'unknown_external_state' END
        WHEN operation_transition.to_state IN ('paused', 'needs_human', 'provider_accepted')
          THEN operation_transition.changes ->> 'reason_code' END,
      blocked_since = CASE WHEN operation_transition.to_state = 'blocked_reconnect' THEN clock_timestamp() END,
      lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
      processing_deadline = CASE WHEN operation_transition.to_state IN ('processing', 'blocked_reconnect')
        THEN coalesce((operation_transition.changes ->> 'processing_deadline')::timestamptz, o.processing_deadline) END,
      poll_deadline = CASE WHEN operation_transition.to_state IN ('provider_accepted', 'blocked_reconnect')
        THEN coalesce((operation_transition.changes ->> 'poll_deadline')::timestamptz, o.poll_deadline) END,
      next_attempt_at = coalesce((operation_transition.changes ->> 'next_attempt_at')::timestamptz, o.next_attempt_at),
      next_check_at = coalesce((operation_transition.changes ->> 'next_check_at')::timestamptz, o.next_check_at),
      step_cursor = coalesce(operation_transition.changes ->> 'step_cursor', o.step_cursor),
      provider_refs = coalesce(operation_transition.changes -> 'provider_refs', o.provider_refs),
      queue = CASE WHEN resend THEN 'publish.' || o.provider_id
        ELSE coalesce(operation_transition.changes ->> 'queue', o.queue) END,
      external_id = coalesce(operation_transition.changes ->> 'external_id', ev -> 'refs' ->> 'external_id', o.external_id),
      unverified_until = coalesce(o.unverified_until, clock_timestamp()
        + make_interval(days => (operation_transition.changes ->> 'unverified_horizon_days')::integer))
    WHERE o.workspace_id = operation_transition.workspace_id AND o.id = operation_transition.operation_id
      AND o.fencing_token = operation_transition.token AND o.state = operation_transition.from_state
    RETURNING o.fencing_token, o.part_index INTO new_token, part;
  landed := FOUND;
  PERFORM set_config('app.idempotent_resend', 'false', true);
  IF NOT landed THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    outcome := 'lost_lease';
    fencing_token := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  IF ev IS NOT NULL THEN
    PERFORM app.ledger_add_evidence(operation_transition.workspace_id, operation_transition.operation_id, part,
      ev ->> 'kind', ev ->> 'level', ev ->> 'outcome_kind', ev -> 'refs');
  END IF;
  INSERT INTO app.outbox (workspace_id, type, payload)
    VALUES (operation_transition.workspace_id, 'operation.' || operation_transition.to_state,
      jsonb_build_object('operation_id', operation_transition.operation_id, 'from', operation_transition.from_state,
        'to', operation_transition.to_state));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  outcome := 'moved';
  fencing_token := new_token;
  RETURN NEXT;
END
$$;

CREATE OR REPLACE FUNCTION app.operation_cancel(workspace_id uuid, operation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  seen record;
BEGIN
  PERFORM set_config('app.job_purpose', 'operation_cancel', true);
  PERFORM app.media_caller(operation_cancel.workspace_id, 3, false);
  PERFORM app.ledger_prelock(operation_cancel.workspace_id, operation_cancel.operation_id);
  SELECT o.state, o.effect, p.author_kind, p.author_id INTO seen FROM app.operations AS o
    JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
    JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
    WHERE o.workspace_id = operation_cancel.workspace_id AND o.id = operation_cancel.operation_id;
  IF NOT FOUND OR (app.tenancy_rank(operation_cancel.workspace_id, app.principal_id()) < 4
      AND NOT (seen.author_kind = 'user' AND seen.author_id = app.principal_id())) THEN
    RAISE EXCEPTION 'operation_cancel: refused' USING ERRCODE = '42501';
  END IF;
  IF seen.effect <> 'none' OR seen.state NOT IN ('pending', 'claimed', 'processing', 'retry_wait', 'paused',
      'blocked_reconnect') THEN
    RAISE EXCEPTION 'operation_cancel: the operation cannot be cancelled' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.operations AS o SET state = 'cancelled', last_actor = 'U', reason_code = NULL, blocked_since = NULL,
      lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, processing_deadline = NULL, poll_deadline = NULL
    WHERE o.workspace_id = operation_cancel.workspace_id AND o.id = operation_cancel.operation_id
      AND o.state = seen.state AND o.effect = 'none';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_cancel: the operation changed, try again' USING ERRCODE = 'SH409';
  END IF;
  INSERT INTO app.outbox (workspace_id, type, payload)
    VALUES (operation_cancel.workspace_id, 'operation.cancelled',
      jsonb_build_object('operation_id', operation_cancel.operation_id, 'from', seen.state, 'to', 'cancelled'));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

CREATE OR REPLACE FUNCTION app.record_evidence(
  workspace_id uuid, operation_id uuid, kind text, level text, outcome_kind text, refs jsonb)
RETURNS TABLE (evidence_id uuid, moved boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  seen record;
BEGIN
  PERFORM set_config('app.job_purpose', 'record_evidence', true);
  PERFORM app.media_caller(record_evidence.workspace_id, 6, true);
  PERFORM app.ledger_prelock(record_evidence.workspace_id, record_evidence.operation_id);
  SELECT o.state, o.effect, o.part_index INTO seen FROM app.operations AS o
    WHERE o.workspace_id = record_evidence.workspace_id AND o.id = record_evidence.operation_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_evidence: refused' USING ERRCODE = '42501';
  END IF;
  evidence_id := app.ledger_add_evidence(record_evidence.workspace_id, record_evidence.operation_id, seen.part_index,
    record_evidence.kind, record_evidence.level, record_evidence.outcome_kind, record_evidence.refs);
  moved := coalesce(record_evidence.kind IN ('accepted', 'verified', 'observed')
      AND record_evidence.outcome_kind IN ('post', 'draft_delivered'), false)
    AND seen.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')
    AND (seen.effect <> 'none' OR seen.state IN ('processing', 'provider_accepted'));
  IF moved THEN
    UPDATE app.operations AS o SET state = 'published', last_actor = 'E', reason_code = NULL, blocked_since = NULL,
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, processing_deadline = NULL,
        poll_deadline = NULL, external_id = coalesce(record_evidence.refs ->> 'external_id', o.external_id)
      WHERE o.workspace_id = record_evidence.workspace_id AND o.id = record_evidence.operation_id;
  END IF;
  IF moved OR seen.state = 'superseded_after_unknown_outcome' THEN
    INSERT INTO app.outbox (workspace_id, type, payload)
      VALUES (record_evidence.workspace_id, CASE WHEN moved THEN 'operation.published' ELSE 'operation.late_evidence' END,
        jsonb_build_object('operation_id', record_evidence.operation_id, 'evidence_id', evidence_id, 'from', seen.state,
          'to', CASE WHEN moved THEN 'published' ELSE seen.state END));
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEXT;
END
$$;

-- A committing start marks the effect (dispatching, effect `possible`, the attempt row) in the caller's own
-- transaction, which commits before the provider is called. Only a committing start counts as an attempt against the
-- manifest's send limits. The quota keys are counted under a lock on a bucket row of their own, taken last of the
-- move's locks, so two starts never count together.
CREATE FUNCTION app.operation_attempt_start(
  p_ws uuid, p_op uuid, p_token bigint, p_owner text, p_step text, p_quotas jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, attempt_id uuid, attempt_no integer)
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
      SELECT count(*) INTO used FROM app.provider_quota_ledger AS l
        WHERE l.provider_id = r.provider_id AND l.provider_account_id = acct AND l.quota_key = k AND l.state <> 'refunded'
          AND l.at > clock_timestamp() - make_interval(secs => (p_quotas -> k ->> 'window_seconds')::integer);
      IF used >= (p_quotas -> k ->> 'capacity')::integer THEN
        PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
        outcome := 'quota_denied';
        RETURN NEXT;
        RETURN;
      END IF;
    END LOOP;
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

-- Fenced by the attempt's token and the operation's current token, so a worker that lost its lease changes nothing;
-- a finished attempt is not written again.
CREATE FUNCTION app.operation_attempt_finish(p_ws uuid, p_attempt uuid, p_token bigint, p_result jsonb)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM app.ledger_caller();
  IF NOT coalesce(p_ws = ANY (app.ws_ids()), false) THEN
    RAISE EXCEPTION 'ledger: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.job_purpose', 'operation_attempt_finish', true);
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_result) AS k WHERE k <> ALL (ARRAY['effect', 'http_status',
       'error_class', 'provider_code', 'retry_after_ms', 'response_excerpt', 'request_fingerprint']))
     OR coalesce(p_result ->> 'effect' NOT IN ('none', 'possible', 'confirmed'), false) THEN
    RAISE EXCEPTION 'operation_attempt_finish: a result that is not allowed' USING ERRCODE = '22023';
  END IF;
  UPDATE app.operation_attempts AS a SET effect = coalesce(p_result ->> 'effect', a.effect), finished_at = clock_timestamp(),
      http_status = (p_result ->> 'http_status')::integer, error_class = p_result ->> 'error_class',
      provider_code = p_result ->> 'provider_code', retry_after_ms = (p_result ->> 'retry_after_ms')::integer,
      response_excerpt = p_result ->> 'response_excerpt', request_fingerprint = p_result ->> 'request_fingerprint'
    FROM app.operations AS o
    WHERE a.workspace_id = p_ws AND a.id = p_attempt AND a.fencing_token = p_token AND a.finished_at IS NULL
      AND o.workspace_id = a.workspace_id AND o.id = a.operation_id AND o.fencing_token = p_token;
  outcome := CASE WHEN FOUND THEN 'finished' ELSE 'lost_lease' END;
  PERFORM set_config('app.job_purpose', 'ledger', true);
  RETURN NEXT;
END
$$;

CREATE FUNCTION app.operation_record_progress(p_ws uuid, p_op uuid, p_token bigint, p_cursor text, p_refs jsonb)
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
     OR (p_cursor IS NOT NULL AND p_cursor !~ '^(prepare:[0-9]{1,3}|await_processing|commit|done)$') THEN
    RAISE EXCEPTION 'operation_record_progress: the references are an object of at most 64 KiB and the cursor a step'
      USING ERRCODE = '22023';
  END IF;
  UPDATE app.operations AS o SET step_cursor = coalesce(p_cursor, o.step_cursor), provider_refs = coalesce(p_refs, o.provider_refs)
    WHERE o.workspace_id = p_ws AND o.id = p_op AND o.fencing_token = p_token
      AND o.state IN ('claimed', 'processing', 'dispatching') AND o.lease_expires_at > clock_timestamp();
  outcome := CASE WHEN FOUND THEN 'recorded' ELSE 'lost_lease' END;
  PERFORM set_config('app.job_purpose', 'ledger', true);
  RETURN NEXT;
END
$$;

-- A target already missed at admission is written by the rollup, with its post locked first, so admission does not
-- write that target itself.
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
  FOR r IN
    SELECT v.id AS variant_id, v.workspace_id AS ws, v.channel_id, v.due_at, v.frozen_version_id, c.provider_id,
        p.author_id, p.id AS post_id
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
    END;
    IF added THEN
      operation_id := new_op; workspace_id := r.ws; queue := 'publish.' || r.provider_id; state := st;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
END
$$;

-- Each candidate is locked with its post and target, skipping any that is held or moved on since it was read: a row
-- that goes to needs_human is an ending the rollup handles.
CREATE OR REPLACE FUNCTION app.claim_reconciles(p_queue text, p_limit integer, p_owner text, p_lease_seconds integer,
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
    SELECT o.id AS oid, o.workspace_id AS ows, o.fencing_token AS tok,
        o.kind = ANY (coalesce(p_class_e_kinds, ARRAY[]::text[])) AS human
      FROM app.operations AS o
      WHERE o.state = 'unknown_external_state' AND o.queue = p_queue AND o.next_check_at <= clock_timestamp()
      ORDER BY o.next_check_at, o.id LIMIT p_limit
  LOOP
    IF NOT app.ledger_lock_target(r.ows, r.oid, 'unknown_external_state', r.tok) THEN
      CONTINUE;
    END IF;
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

-- The deadlines of an unknown outcome are set in the same move. A row that becomes unknown_external_state is due for
-- its first read-back after the provider's backoff (60 seconds for an unlisted provider, 0 for one that cannot read
-- back); the first `unverified_until` that was set is kept.
DROP FUNCTION app.sweep_expired_leases();
CREATE FUNCTION app.sweep_expired_leases(p_providers jsonb DEFAULT '{}'::jsonb)
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
  IF jsonb_typeof(p_providers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'sweep_expired_leases: the providers are an object' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, p_providers -> o.provider_id AS facts
      FROM app.operations AS o
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
        UPDATE app.operations AS o SET state = CASE WHEN r.was = 'claimed' THEN 'pending' ELSE 'unknown_external_state' END,
            last_actor = 'X', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
            queue = CASE WHEN r.was = 'claimed' THEN o.queue ELSE 'reconcile.' || o.provider_id END,
            next_check_at = CASE WHEN r.was = 'claimed' THEN o.next_check_at ELSE clock_timestamp()
              + make_interval(secs => coalesce((r.facts ->> 'first_backoff_seconds')::float8, 60)) END,
            unverified_until = CASE WHEN r.was = 'claimed' THEN o.unverified_until ELSE coalesce(o.unverified_until,
              clock_timestamp() + make_interval(days => (r.facts ->> 'unverified_horizon_days')::integer)) END
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

CREATE OR REPLACE FUNCTION app.ledger_due_move(p_ws uuid, p_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  was text;
  entered text;
BEGIN
  PERFORM app.ledger_prelock(p_ws, p_id);
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

-- One row at a time, so the guard's refusal of one row leaves the others moved. Each row is locked with its post and
-- target first and skipped when it moved on or is held. Attempts exhausted and the unverified horizon apply only to
-- providers in `p_live_providers`. A pause ends for a provider cooldown whose time came, a disabled channel that is
-- connected again, and an api_sunset pause of a provider that is live again.
DROP FUNCTION app.sweep_due_moves();
CREATE FUNCTION app.sweep_due_moves(p_live_providers jsonb DEFAULT '{}'::jsonb)
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
  IF jsonb_typeof(p_live_providers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'sweep_due_moves: the live providers are an object' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, o.fencing_token AS tok FROM app.operations AS o
      WHERE o.state = 'retry_wait' AND o.effect = 'none' AND jsonb_exists(p_live_providers, o.provider_id)
        AND o.attempt_count >= (p_live_providers -> o.provider_id ->> 'max_attempts')::integer
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
      NULL;
    END;
  END LOOP;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, o.fencing_token AS tok FROM app.operations AS o
      WHERE o.state IN ('reconciling', 'unknown_external_state') AND o.unverified_until <= clock_timestamp()
        AND jsonb_exists(p_live_providers, o.provider_id)
        AND (o.lease_expires_at IS NULL OR o.lease_expires_at < clock_timestamp())
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
      NULL;
    END;
  END LOOP;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, o.fencing_token AS tok FROM app.channels AS c
      JOIN app.operations AS o ON o.workspace_id = c.workspace_id AND o.channel_id = c.id
      WHERE c.connection_state = 'connected' AND o.state = 'paused' AND o.reason_code = 'channel_disabled'
      ORDER BY o.id LIMIT 500
  LOOP
    BEGIN
      IF app.ledger_lock_target(r.ows, r.oid, r.was, r.tok) THEN
        PERFORM app.ledger_due_move(r.ows, r.oid);
        moved := moved + 1;
      END IF;
    EXCEPTION WHEN SQLSTATE 'SH409' THEN
      NULL;
    END;
  END LOOP;
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, o.fencing_token AS tok FROM app.operations AS o
      WHERE o.state IN ('pending', 'retry_wait', 'paused')
        AND ((o.effect = 'none' AND clock_timestamp() > o.lateness_deadline + o.blocked_total)
          OR (o.state = 'retry_wait' AND o.next_attempt_at <= clock_timestamp())
          OR (o.state = 'paused' AND o.reason_code = 'provider_cooldown' AND o.next_attempt_at <= clock_timestamp())
          OR (o.state = 'paused' AND o.reason_code = 'api_sunset' AND jsonb_exists(p_live_providers, o.provider_id)))
      ORDER BY o.id LIMIT 500
  LOOP
    BEGIN
      IF app.ledger_lock_target(r.ows, r.oid, r.was, r.tok) THEN
        PERFORM app.ledger_due_move(r.ows, r.oid);
        moved := moved + 1;
      END IF;
    EXCEPTION WHEN SQLSTATE 'SH409' THEN
      NULL;
    END;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
  RETURN moved;
END
$$;

-- Only an Owner, an Admin or the Editor who wrote the post may resolve; anyone else is refused like an unknown id. A
-- kind that would send (attest_not_executed, publish_late, supersede) is refused unless the channel is connected. The
-- step-up time is only stamped here; the route has checked it. Lock order: the post and its target, the channel FOR
-- SHARE, then the operation.
CREATE FUNCTION app.resolve_operation(p_ws uuid, p_op uuid, p_kind text, p_args jsonb DEFAULT '{}'::jsonb)
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
  -- A drop or reschedule of a post that may have been sent needs `absent` evidence read after its latest attempt began
  -- (any, when it has no attempt); the move then resets the effect.
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

-- Counts across every workspace and carries no tenant data; the admin route that calls it is the gate.
CREATE FUNCTION app.ledger_state_counts()
RETURNS TABLE (state text, total bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'ledger_state_counts', true);
  RETURN QUERY SELECT s.name, count(o.id) FROM unnest(ARRAY['pending', 'claimed', 'processing', 'dispatching',
      'provider_accepted', 'retry_wait', 'paused', 'blocked_reconnect', 'unknown_external_state', 'reconciling',
      'needs_human', 'unverified', 'published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome'])
      AS s (name) LEFT JOIN app.operations AS o ON o.state = s.name GROUP BY s.name ORDER BY s.name;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.ledger_prelock(uuid, uuid), app.ledger_lock_target(uuid, uuid, text, bigint),
  app.ledger_rollup(uuid, uuid, text), app.operations_rollup(), app.operations_usage(), app.ledger_guard(),
  app.operation_transition(uuid, uuid, bigint, text, text, text, jsonb), app.operation_cancel(uuid, uuid),
  app.record_evidence(uuid, uuid, text, text, text, jsonb),
  app.operation_attempt_start(uuid, uuid, bigint, text, text, jsonb),
  app.operation_attempt_finish(uuid, uuid, bigint, jsonb),
  app.operation_record_progress(uuid, uuid, bigint, text, jsonb),
  app.admit_due_targets(integer, jsonb), app.claim_reconciles(text, integer, text, integer, text[]),
  app.sweep_expired_leases(jsonb), app.ledger_due_move(uuid, uuid), app.sweep_due_moves(jsonb),
  app.resolve_operation(uuid, uuid, text, jsonb), app.ledger_state_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operation_transition(uuid, uuid, bigint, text, text, text, jsonb),
  app.record_evidence(uuid, uuid, text, text, text, jsonb),
  app.operation_attempt_start(uuid, uuid, bigint, text, text, jsonb),
  app.operation_attempt_finish(uuid, uuid, bigint, jsonb),
  app.operation_record_progress(uuid, uuid, bigint, text, jsonb),
  app.admit_due_targets(integer, jsonb), app.claim_reconciles(text, integer, text, integer, text[]),
  app.sweep_expired_leases(jsonb), app.sweep_due_moves(jsonb) TO shoutory_worker;
GRANT EXECUTE ON FUNCTION app.operation_cancel(uuid, uuid), app.resolve_operation(uuid, uuid, text, jsonb),
  app.ledger_state_counts() TO shoutory_app;
RESET ROLE;
REVOKE TRIGGER ON app.operations FROM shoutory_definer;
