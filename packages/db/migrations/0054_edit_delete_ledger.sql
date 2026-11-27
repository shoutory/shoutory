-- An edit moves to published only on its own `edit_applied` evidence and a delete only on `removed`; evidence that a post
-- exists moves neither, and an edit's evidence never moves a publish. A delete's presence follows its operation: the
-- first value is written when the delete is inserted.
DROP TRIGGER operations_c_rollup_insert ON app.operations;
GRANT TRIGGER ON app.operations TO shoutory_definer;
SET ROLE shoutory_definer;

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
  opkind text;
  fits boolean;
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
       OR coalesce(ev ->> 'kind' NOT IN ('accepted', 'verified', 'observed', 'edit_applied', 'removed'), true)) THEN
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
    RETURNING o.fencing_token, o.part_index, o.kind INTO new_token, part, opkind;
  landed := FOUND;
  PERFORM set_config('app.idempotent_resend', 'false', true);
  IF NOT landed THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    outcome := 'lost_lease';
    fencing_token := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  fits := CASE opkind
    WHEN 'edit' THEN ev ->> 'kind' = 'edit_applied' AND ev ->> 'outcome_kind' IS NULL
    WHEN 'delete' THEN ev ->> 'kind' = 'removed' AND ev ->> 'outcome_kind' IS NULL
    ELSE ev ->> 'kind' IN ('accepted', 'verified', 'observed') AND ev ->> 'outcome_kind' IN ('post', 'draft_delivered')
  END;
  IF operation_transition.to_state = 'published' AND want IS NOT NULL AND NOT coalesce(fits, false) THEN
    RAISE EXCEPTION 'operation_transition: this evidence does not move an operation of kind %', opkind USING ERRCODE = '22023';
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
  SELECT o.state, o.effect, o.part_index, o.kind INTO seen FROM app.operations AS o
    WHERE o.workspace_id = record_evidence.workspace_id AND o.id = record_evidence.operation_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_evidence: refused' USING ERRCODE = '42501';
  END IF;
  evidence_id := app.ledger_add_evidence(record_evidence.workspace_id, record_evidence.operation_id, seen.part_index,
    record_evidence.kind, record_evidence.level, record_evidence.outcome_kind, record_evidence.refs);
  moved := coalesce(CASE seen.kind
      WHEN 'edit' THEN record_evidence.kind = 'edit_applied' AND record_evidence.outcome_kind IS NULL
      WHEN 'delete' THEN record_evidence.kind = 'removed' AND record_evidence.outcome_kind IS NULL
      ELSE record_evidence.kind IN ('accepted', 'verified', 'observed')
        AND record_evidence.outcome_kind IN ('post', 'draft_delivered')
    END, false)
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
    shown := CASE
      WHEN NEW.state = 'published' THEN 'removed_at_provider'
      WHEN NEW.state IN ('needs_human', 'unverified') THEN 'removal_unknown'
      WHEN NEW.state IN ('failed', 'cancelled', 'missed') THEN CASE WHEN NEW.effect = 'none' THEN 'present' END
      WHEN NEW.state = 'superseded_after_unknown_outcome' THEN NULL
      WHEN NEW.state IN ('blocked_reconnect', 'paused') AND TG_OP = 'UPDATE' THEN NULL
      ELSE 'removal_pending' END;
    IF shown IS NOT NULL THEN
      PERFORM set_config('app.job_purpose', 'operation_rollup', true);
      UPDATE app.post_variants AS v SET presence = shown, updated_at = clock_timestamp()
        WHERE v.workspace_id = NEW.workspace_id AND v.id = NEW.variant_id
          AND v.presence NOT IN ('removal_reported', shown);
      PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
      PERFORM app.ledger_rollup(NEW.workspace_id, NEW.variant_id, NULL);
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER operations_c_rollup_insert AFTER INSERT ON app.operations
  FOR EACH ROW WHEN (NEW.state = 'missed' OR NEW.kind = 'delete') EXECUTE FUNCTION app.operations_rollup();
RESET ROLE;
REVOKE TRIGGER ON app.operations FROM shoutory_definer;
