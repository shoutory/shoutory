-- The writers of the publishing ledger. A worker moves an operation only with the fencing token it holds, so one that lost
-- its lease changes nothing; the insert has no runtime caller (admission and the human resolutions call it as the
-- definer role). Each writer runs under a purpose of its own and writes one outbox row for every move it makes.

-- What the definer role may write: the operations and their evidence, and the event outbox. An operation is changed in
-- the columns the ledger definers write and no others; the token, the settled time and the update time are set by the
-- transition trigger of 0019, the key and target columns never change.
GRANT INSERT ON app.operations, app.operation_evidence TO shoutory_definer;
GRANT UPDATE (state, effect, reason_code, last_actor, blocked_since, lease_owner, lease_expires_at, heartbeat_at,
  processing_deadline, poll_deadline, step_cursor, provider_refs, next_attempt_at, next_check_at, queue,
  external_id) ON app.operations TO shoutory_definer;

-- The principal check reads the tenancy tables under the purpose of the definer that calls it (the 0016 way).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['operation_transition', 'operation_cancel', 'record_evidence']);
  END LOOP;
END
$$;
CALL app.grant_purposes('operations', 'INSERT', ARRAY['operation_insert']);
-- An UPDATE with a WHERE and a row lock need the SELECT policy as well as the UPDATE one.
CALL app.grant_purposes('operations', 'SELECT', ARRAY['operation_transition', 'operation_cancel', 'record_evidence']);
CALL app.grant_purposes('operations', 'UPDATE', ARRAY['operation_transition', 'operation_cancel', 'record_evidence']);
-- The cancel reads the post of the operation to know its author.
CALL app.grant_purposes('post_variants', 'SELECT', ARRAY['operation_cancel']);
CALL app.grant_purposes('posts', 'SELECT', ARRAY['operation_cancel']);
-- The move is looked up in the transition table.
CALL app.grant_purposes('ledger_transitions', 'SELECT', ARRAY['operation_transition']);
CALL app.grant_purposes('operation_evidence', 'INSERT', ARRAY['operation_transition', 'record_evidence']);
-- The move to blocked_reconnect reads the channel and holds it FOR SHARE, which needs an UPDATE privilege and policy.
CALL app.grant_purposes('channels', 'SELECT', ARRAY['operation_transition']);
CALL app.grant_purposes('channels', 'UPDATE', ARRAY['operation_transition']);

SET ROLE shoutory_definer;

-- The outbox belongs to the definer role (0012), which holds every privilege on it already; its insert policies are
-- created by the table's owner, in the form app.grant_purposes gives them. The first producer of events adds its purpose
-- (the 0012 note).
CREATE POLICY operation_transition_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'operation_transition');
CREATE POLICY operation_cancel_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'operation_cancel');
CREATE POLICY record_evidence_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'record_evidence');

-- Stores one row of evidence for an operation, inside the caller's purpose (no entry point, no runtime EXECUTE). Level
-- human is the resolver's alone, and the references are a closed set: `source` is required, `external_id` and `permalink`
-- are kept. It writes the row and decides nothing; the caller holds the operation row.
CREATE FUNCTION app.ledger_add_evidence(
  workspace_id uuid, operation_id uuid, part integer, kind text, level text, outcome_kind text, refs jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  new_id constant uuid := uuidv7();
BEGIN
  IF ledger_add_evidence.level IS NULL OR ledger_add_evidence.level = 'human' THEN
    RAISE EXCEPTION 'ledger: evidence of level human is the resolver''s' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(ledger_add_evidence.refs) IS DISTINCT FROM 'object'
     OR NOT jsonb_exists(ledger_add_evidence.refs, 'source')
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(ledger_add_evidence.refs) AS k
       WHERE k <> ALL (ARRAY['external_id', 'permalink', 'source'])) THEN
    RAISE EXCEPTION 'ledger: the references of evidence are source, external_id and permalink' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.operation_evidence (id, workspace_id, operation_id, part_index, kind, level, outcome_kind, external_id,
      permalink, source)
    VALUES (new_id, ledger_add_evidence.workspace_id, ledger_add_evidence.operation_id, ledger_add_evidence.part,
      ledger_add_evidence.kind, ledger_add_evidence.level, ledger_add_evidence.outcome_kind,
      ledger_add_evidence.refs ->> 'external_id', ledger_add_evidence.refs ->> 'permalink',
      ledger_add_evidence.refs ->> 'source');
  RETURN new_id;
END
$$;

-- Creates an operation for the scheduler (S) or a person (U); no runtime role runs it, admission and the resolutions call
-- it as the definer role. The keys of `fields` are a closed set (a reply or moderation target, the effect, the token and
-- the actor are never named), and the move from nothing into `state` is the transition trigger's to allow. It writes no
-- outbox row: admission writes its own event.
CREATE FUNCTION app.operation_insert(workspace_id uuid, fields jsonb, actor text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  new_id constant uuid := uuidv7();
BEGIN
  PERFORM set_config('app.job_purpose', 'operation_insert', true);
  IF operation_insert.actor IS NULL OR operation_insert.actor NOT IN ('S', 'U') THEN
    RAISE EXCEPTION 'operation_insert: the actor is S or U' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(operation_insert.fields) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(operation_insert.fields) AS k WHERE k <> ALL (ARRAY['variant_id',
       'channel_id', 'provider_id', 'queue', 'kind', 'part_index', 'depends_on_operation_id', 'state', 'reason_code',
       'due_at', 'lateness_deadline', 'blocked_since', 'idempotency_marker', 'frozen_version_id',
       'frozen_snapshot_hash', 'approval_grant_id', 'supersedes_operation_id', 'lease_seconds', 'next_attempt_at',
       'requested_by'])) THEN
    RAISE EXCEPTION 'operation_insert: an unknown key' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.operations (id, workspace_id, variant_id, channel_id, provider_id, queue, kind, part_index,
      depends_on_operation_id, state, reason_code, due_at, lateness_deadline, blocked_since, idempotency_marker,
      frozen_version_id, frozen_snapshot_hash, approval_grant_id, supersedes_operation_id, lease_seconds,
      next_attempt_at, requested_by, last_actor)
    VALUES (new_id, operation_insert.workspace_id, (operation_insert.fields ->> 'variant_id')::uuid,
      (operation_insert.fields ->> 'channel_id')::uuid, operation_insert.fields ->> 'provider_id',
      operation_insert.fields ->> 'queue', operation_insert.fields ->> 'kind',
      coalesce((operation_insert.fields ->> 'part_index')::integer, 0),
      (operation_insert.fields ->> 'depends_on_operation_id')::uuid, operation_insert.fields ->> 'state',
      operation_insert.fields ->> 'reason_code', (operation_insert.fields ->> 'due_at')::timestamptz,
      (operation_insert.fields ->> 'lateness_deadline')::timestamptz,
      (operation_insert.fields ->> 'blocked_since')::timestamptz, operation_insert.fields ->> 'idempotency_marker',
      (operation_insert.fields ->> 'frozen_version_id')::uuid,
      decode(operation_insert.fields ->> 'frozen_snapshot_hash', 'hex'),
      (operation_insert.fields ->> 'approval_grant_id')::uuid,
      (operation_insert.fields ->> 'supersedes_operation_id')::uuid,
      (operation_insert.fields ->> 'lease_seconds')::integer, (operation_insert.fields ->> 'next_attempt_at')::timestamptz,
      (operation_insert.fields ->> 'requested_by')::uuid, operation_insert.actor);
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;

-- The fenced write of a worker (W), a poller (P) or the reconciler (R): one UPDATE that names the token and the state the
-- caller holds, so a caller that lost its lease finds no row and gets `lost_lease` (never an error) and changes nothing.
-- The move itself is the transition trigger's to allow. The claims (rows 4, 33, 34) and the moves that reset an effect
-- (rows 19, 20, 21, 24, 36) have their own definers and are refused here. `changes` is a closed set of keys; a move into
-- dispatching sets the effect marker and keeps the lease it came with, every other move drops the lease, and a column
-- the new state does not hold is cleared. A move into published carries the evidence of its row, stored in the same
-- transaction. Locks: the channel FOR SHARE (rank 5) for a move to blocked_reconnect, then the operation row by the
-- UPDATE (6), then the evidence (7) and the outbox (10).
CREATE FUNCTION app.operation_transition(
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
BEGIN
  PERFORM set_config('app.job_purpose', 'operation_transition', true);
  PERFORM app.media_caller(operation_transition.workspace_id, 6, true);
  IF operation_transition.actor IS NULL OR operation_transition.actor NOT IN ('W', 'P', 'R') THEN
    RAISE EXCEPTION 'operation_transition: the actor is W, P or R' USING ERRCODE = '22023';
  END IF;
  IF (operation_transition.from_state, operation_transition.to_state, operation_transition.actor) IN (
      ('pending', 'claimed', 'W'), ('unknown_external_state', 'reconciling', 'R'),
      ('unknown_external_state', 'needs_human', 'R'), ('dispatching', 'retry_wait', 'W'),
      ('dispatching', 'failed', 'W'), ('dispatching', 'paused', 'W'), ('provider_accepted', 'failed', 'P'),
      ('reconciling', 'retry_wait', 'R')) THEN
    RAISE EXCEPTION 'operation_transition: this move has its own definer' USING ERRCODE = '42501';
  END IF;
  -- The move must be in the transition table for this actor, here and not only in the trigger: the trigger lets a call that
  -- leaves the state as it is pass, and such a call would rewrite the row and announce the state a second time.
  IF operation_transition.from_state IS NOT DISTINCT FROM operation_transition.to_state
     OR NOT EXISTS (SELECT 1 FROM app.ledger_transitions AS t WHERE t.from_state = operation_transition.from_state
       AND t.to_state = operation_transition.to_state AND t.actor = operation_transition.actor) THEN
    RAISE EXCEPTION 'operation_transition: this move is not in the transition table' USING ERRCODE = 'SH409';
  END IF;
  IF jsonb_typeof(operation_transition.changes) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(operation_transition.changes) AS k WHERE k <> ALL (ARRAY['reason_code',
       'next_attempt_at', 'next_check_at', 'poll_deadline', 'processing_deadline', 'step_cursor', 'provider_refs',
       'queue', 'external_id', 'lease_expires_at', 'heartbeat_at', 'evidence']))
     OR ((jsonb_exists(operation_transition.changes, 'lease_expires_at')
       OR jsonb_exists(operation_transition.changes, 'heartbeat_at')) AND operation_transition.to_state <> 'dispatching')
     OR (jsonb_exists(operation_transition.changes, 'reason_code')
       AND operation_transition.to_state NOT IN ('paused', 'needs_human', 'provider_accepted'))
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
  UPDATE app.operations AS o SET
      state = operation_transition.to_state,
      last_actor = operation_transition.actor,
      effect = CASE WHEN operation_transition.to_state = 'dispatching' THEN 'possible' ELSE o.effect END,
      reason_code = CASE
        WHEN operation_transition.to_state = 'blocked_reconnect' THEN CASE operation_transition.from_state
          WHEN 'claimed' THEN 'pending' WHEN 'processing' THEN 'pending' WHEN 'provider_accepted' THEN 'provider_accepted'
          ELSE 'unknown_external_state' END
        WHEN operation_transition.to_state IN ('paused', 'needs_human', 'provider_accepted')
          THEN operation_transition.changes ->> 'reason_code' END,
      blocked_since = CASE WHEN operation_transition.to_state = 'blocked_reconnect' THEN clock_timestamp() END,
      lease_owner = CASE WHEN operation_transition.to_state = 'dispatching' THEN o.lease_owner END,
      lease_expires_at = CASE WHEN operation_transition.to_state = 'dispatching'
        THEN coalesce((operation_transition.changes ->> 'lease_expires_at')::timestamptz, o.lease_expires_at) END,
      heartbeat_at = CASE WHEN operation_transition.to_state = 'dispatching'
        THEN coalesce((operation_transition.changes ->> 'heartbeat_at')::timestamptz, o.heartbeat_at) END,
      processing_deadline = CASE WHEN operation_transition.to_state IN ('processing', 'blocked_reconnect')
        THEN coalesce((operation_transition.changes ->> 'processing_deadline')::timestamptz, o.processing_deadline) END,
      poll_deadline = CASE WHEN operation_transition.to_state IN ('provider_accepted', 'blocked_reconnect')
        THEN coalesce((operation_transition.changes ->> 'poll_deadline')::timestamptz, o.poll_deadline) END,
      next_attempt_at = coalesce((operation_transition.changes ->> 'next_attempt_at')::timestamptz, o.next_attempt_at),
      next_check_at = coalesce((operation_transition.changes ->> 'next_check_at')::timestamptz, o.next_check_at),
      step_cursor = coalesce(operation_transition.changes ->> 'step_cursor', o.step_cursor),
      provider_refs = coalesce(operation_transition.changes -> 'provider_refs', o.provider_refs),
      queue = coalesce(operation_transition.changes ->> 'queue', o.queue),
      external_id = coalesce(operation_transition.changes ->> 'external_id', ev -> 'refs' ->> 'external_id', o.external_id)
    WHERE o.workspace_id = operation_transition.workspace_id AND o.id = operation_transition.operation_id
      AND o.fencing_token = operation_transition.token AND o.state = operation_transition.from_state
      AND (operation_transition.to_state <> 'dispatching' OR o.lease_owner IS NOT NULL)
    RETURNING o.fencing_token, o.part_index INTO new_token, part;
  IF NOT FOUND THEN
    -- A caller that holds the token and the state but no lease is not a lost lease: the claim that gives the lease comes first.
    IF operation_transition.to_state = 'dispatching' AND EXISTS (SELECT 1 FROM app.operations AS o
        WHERE o.workspace_id = operation_transition.workspace_id AND o.id = operation_transition.operation_id
          AND o.fencing_token = operation_transition.token AND o.state = operation_transition.from_state) THEN
      RAISE EXCEPTION 'operation_transition: a move into dispatching needs the lease of a claim' USING ERRCODE = 'SH409';
    END IF;
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

-- Cancels an operation that has had no effect, for a signed-in Owner or Admin, or for the Editor who wrote the post
-- (the `publish.resolve` rule; an Approver or a Viewer, a job and a stranger are refused like an unknown id). The state
-- must be one a cancel may leave (row 8) and the effect none; the lease, the deadlines and the blocked columns go, and
-- the trigger raises the token so a worker still running loses its next write. Locks: the unlocked reads of the post and
-- its variant, then the operation row by the UPDATE (6) and the outbox (10).
CREATE FUNCTION app.operation_cancel(workspace_id uuid, operation_id uuid)
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

-- Records what the provider or a person said about an operation, and never waits for a lease: any job may call it. It always
-- stores the row. When the evidence is a receipt or better (never level human, which is the resolver's) of a post, and
-- the operation is not settled and its effect is possible or confirmed (or it is processing or provider_accepted), the
-- operation moves to published, the token rises so a holder of the old lease loses its next write, and the external id
-- is kept (row 40). Evidence of any other kind or outcome, of a settled operation, or of one that may not have been
-- sent only adds the row; a superseded operation also writes the late-evidence event (row 47). Locks: the operation row
-- FOR NO KEY UPDATE (6), the evidence insert (7), the outbox (10).
CREATE FUNCTION app.record_evidence(
  workspace_id uuid, operation_id uuid, kind text, level text, outcome_kind text, refs jsonb)
RETURNS TABLE (evidence_id uuid, moved boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  seen record;
  ends boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'record_evidence', true);
  PERFORM app.media_caller(record_evidence.workspace_id, 6, true);
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

REVOKE ALL ON FUNCTION app.ledger_add_evidence(uuid, uuid, integer, text, text, text, jsonb),
  app.operation_insert(uuid, jsonb, text),
  app.operation_transition(uuid, uuid, bigint, text, text, text, jsonb),
  app.operation_cancel(uuid, uuid),
  app.record_evidence(uuid, uuid, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operation_transition(uuid, uuid, bigint, text, text, text, jsonb),
  app.record_evidence(uuid, uuid, text, text, text, jsonb) TO shoutory_worker;
GRANT EXECUTE ON FUNCTION app.operation_cancel(uuid, uuid) TO shoutory_app;
RESET ROLE;
