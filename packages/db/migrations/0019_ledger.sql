-- The publishing ledger: one row per external effect, the attempts and the evidence behind it, the human resolutions, the
-- media it pins, the usage it reserves, and the table of state moves the database allows. The runtime roles read these
-- tables and write nothing: the ledger definers of a later migration are their only writers, under purposes of their own.

-- The moves the ledger allows: one row per (row, from, to, actor) of the transition table. A row of the table that lists
-- several from-states, to-states or actors is one entry here for every combination. Two rows may name one move (23 and 40,
-- 32 and 48, 42 and 43), so the key starts with the row number and the move itself is only indexed. It is seeded here and
-- nowhere else; a test compares it with the list in core. Seeded before row security is applied: the table is template I.
CREATE TABLE app.ledger_transitions (
  row_no integer NOT NULL CHECK (row_no BETWEEN 1 AND 51),
  from_state text NOT NULL CHECK (from_state IN ('none', 'pending', 'claimed', 'processing', 'dispatching',
    'provider_accepted', 'retry_wait', 'paused', 'blocked_reconnect', 'unknown_external_state', 'reconciling',
    'needs_human', 'unverified', 'published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')),
  to_state text NOT NULL CHECK (to_state IN ('pending', 'claimed', 'processing', 'dispatching', 'provider_accepted',
    'retry_wait', 'paused', 'blocked_reconnect', 'unknown_external_state', 'reconciling', 'needs_human', 'unverified',
    'published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')),
  actor text NOT NULL CHECK (actor IN ('S', 'W', 'P', 'R', 'E', 'U', 'X')),
  guard text NOT NULL CHECK (char_length(guard) BETWEEN 1 AND 64),
  bumps_fence boolean NOT NULL,
  PRIMARY KEY (row_no, from_state, to_state, actor)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX ledger_transitions_move_idx ON app.ledger_transitions (from_state, to_state, actor);
INSERT INTO app.ledger_transitions (row_no, from_state, to_state, actor, guard, bumps_fence)
SELECT m.row_no, f, t, a, m.guard, a = ANY (m.bumped_by)
FROM (VALUES
  (1, ARRAY['none'], ARRAY['pending'], ARRAY['S'], 'admit_free_slot', ARRAY[]::text[]),
  (2, ARRAY['none'], ARRAY['missed'], ARRAY['S'], 'late_at_admission', ARRAY[]::text[]),
  (3, ARRAY['none'], ARRAY['blocked_reconnect', 'paused'], ARRAY['S'], 'channel_unavailable', ARRAY[]::text[]),
  (4, ARRAY['pending'], ARRAY['claimed'], ARRAY['W'], 'due_in_window', ARRAY['W']),
  (5, ARRAY['pending', 'retry_wait', 'paused'], ARRAY['missed'], ARRAY['S'], 'late_effect_none', ARRAY[]::text[]),
  (6, ARRAY['pending', 'retry_wait'], ARRAY['paused'], ARRAY['S', 'W'], 'pause_reason', ARRAY[]::text[]),
  (7, ARRAY['pending', 'retry_wait', 'paused'], ARRAY['blocked_reconnect'], ARRAY['S'], 'channel_left', ARRAY[]::text[]),
  (8, ARRAY['pending', 'claimed', 'processing', 'retry_wait', 'paused', 'blocked_reconnect'], ARRAY['cancelled'], ARRAY['U'], 'cancel_effect_none', ARRAY['U']),
  (9, ARRAY['claimed'], ARRAY['dispatching'], ARRAY['W'], 'prepare_done', ARRAY[]::text[]),
  (10, ARRAY['claimed'], ARRAY['pending'], ARRAY['X', 'W'], 'lease_expired_or_drain', ARRAY['X']),
  (11, ARRAY['claimed'], ARRAY['processing'], ARRAY['W'], 'provider_preparing', ARRAY[]::text[]),
  (12, ARRAY['claimed'], ARRAY['retry_wait', 'paused', 'failed'], ARRAY['W'], 'prepare_failure', ARRAY[]::text[]),
  (13, ARRAY['claimed', 'processing', 'provider_accepted', 'unknown_external_state', 'reconciling'], ARRAY['blocked_reconnect'], ARRAY['W', 'P', 'R'], 'revocation_confirmed', ARRAY[]::text[]),
  (14, ARRAY['processing'], ARRAY['dispatching'], ARRAY['P'], 'media_ready', ARRAY[]::text[]),
  (15, ARRAY['processing'], ARRAY['retry_wait'], ARRAY['P', 'X'], 'processing_failed_retryable', ARRAY['X']),
  (16, ARRAY['processing'], ARRAY['failed'], ARRAY['P', 'S'], 'processing_rejected', ARRAY[]::text[]),
  (17, ARRAY['dispatching'], ARRAY['published'], ARRAY['W'], 'receipt', ARRAY[]::text[]),
  (18, ARRAY['dispatching'], ARRAY['provider_accepted'], ARRAY['W'], 'async_accept', ARRAY[]::text[]),
  (19, ARRAY['dispatching'], ARRAY['retry_wait'], ARRAY['W'], 'no_effect_retry', ARRAY[]::text[]),
  (20, ARRAY['dispatching'], ARRAY['failed'], ARRAY['W'], 'no_effect_permanent', ARRAY[]::text[]),
  (21, ARRAY['dispatching'], ARRAY['paused'], ARRAY['W'], 'no_effect_cooldown', ARRAY[]::text[]),
  (22, ARRAY['dispatching'], ARRAY['unknown_external_state'], ARRAY['W', 'X'], 'outcome_unknown', ARRAY['X']),
  (23, ARRAY['provider_accepted'], ARRAY['published'], ARRAY['P', 'E'], 'poll_or_webhook', ARRAY[]::text[]),
  (24, ARRAY['provider_accepted'], ARRAY['failed'], ARRAY['P'], 'terminal_failure_absent', ARRAY[]::text[]),
  (25, ARRAY['provider_accepted'], ARRAY['unknown_external_state'], ARRAY['P'], 'poll_deadline_passed', ARRAY[]::text[]),
  (26, ARRAY['retry_wait'], ARRAY['pending'], ARRAY['S'], 'retry_due', ARRAY[]::text[]),
  (27, ARRAY['retry_wait'], ARRAY['failed'], ARRAY['S'], 'attempts_exhausted', ARRAY[]::text[]),
  (28, ARRAY['paused'], ARRAY['pending'], ARRAY['S'], 'reason_cleared', ARRAY[]::text[]),
  (29, ARRAY['blocked_reconnect'], ARRAY['pending'], ARRAY['S'], 'reconnected_in_window', ARRAY[]::text[]),
  (30, ARRAY['blocked_reconnect'], ARRAY['needs_human'], ARRAY['S'], 'reconnected_late', ARRAY[]::text[]),
  (31, ARRAY['blocked_reconnect'], ARRAY['unknown_external_state', 'provider_accepted'], ARRAY['S'], 'reconnected_effect_kept', ARRAY[]::text[]),
  (32, ARRAY['blocked_reconnect'], ARRAY['cancelled'], ARRAY['S'], 'reconnect_deadline_passed', ARRAY[]::text[]),
  (33, ARRAY['unknown_external_state'], ARRAY['reconciling'], ARRAY['R'], 'claim_reconcile', ARRAY['R']),
  (34, ARRAY['unknown_external_state'], ARRAY['needs_human'], ARRAY['R'], 'class_e_human', ARRAY['R']),
  (35, ARRAY['reconciling'], ARRAY['published'], ARRAY['R'], 'read_back_found', ARRAY[]::text[]),
  (36, ARRAY['reconciling'], ARRAY['retry_wait'], ARRAY['R'], 'absence_proven', ARRAY[]::text[]),
  (37, ARRAY['reconciling'], ARRAY['unknown_external_state'], ARRAY['R', 'X'], 'inconclusive_or_lease_expired', ARRAY['X']),
  (38, ARRAY['reconciling'], ARRAY['needs_human'], ARRAY['R'], 'ambiguous_or_unprovable', ARRAY[]::text[]),
  (39, ARRAY['reconciling', 'unknown_external_state'], ARRAY['unverified'], ARRAY['R', 'S'], 'unverified_horizon', ARRAY[]::text[]),
  (40, ARRAY['pending', 'claimed', 'processing', 'dispatching', 'provider_accepted', 'retry_wait', 'paused', 'blocked_reconnect', 'unknown_external_state', 'reconciling', 'needs_human', 'unverified'], ARRAY['published'], ARRAY['E'], 'receipt_evidence', ARRAY['E']),
  (41, ARRAY['needs_human', 'unverified'], ARRAY['published'], ARRAY['U'], 'attest_published', ARRAY[]::text[]),
  (42, ARRAY['needs_human'], ARRAY['retry_wait'], ARRAY['U'], 'attest_not_executed', ARRAY[]::text[]),
  (43, ARRAY['needs_human'], ARRAY['retry_wait'], ARRAY['U'], 'publish_late', ARRAY[]::text[]),
  (44, ARRAY['needs_human'], ARRAY['cancelled'], ARRAY['U'], 'drop_or_reschedule', ARRAY[]::text[]),
  (45, ARRAY['needs_human'], ARRAY['unverified'], ARRAY['U'], 'dismiss', ARRAY[]::text[]),
  (46, ARRAY['needs_human', 'unverified'], ARRAY['superseded_after_unknown_outcome'], ARRAY['U'], 'supersede', ARRAY[]::text[]),
  (47, ARRAY['superseded_after_unknown_outcome'], ARRAY['superseded_after_unknown_outcome'], ARRAY['E'], 'late_evidence', ARRAY[]::text[]),
  (48, ARRAY['pending', 'claimed', 'processing', 'retry_wait', 'paused', 'blocked_reconnect'], ARRAY['cancelled'], ARRAY['S'], 'policy_cancel', ARRAY['S']),
  (49, ARRAY['provider_accepted'], ARRAY['needs_human'], ARRAY['S'], 'awaiting_user_timeout', ARRAY[]::text[]),
  (50, ARRAY['none'], ARRAY['pending'], ARRAY['U'], 'user_insert', ARRAY[]::text[]),
  (51, ARRAY['claimed'], ARRAY['needs_human'], ARRAY['W'], 'media_unreachable', ARRAY[]::text[])
) AS m (row_no, froms, tos, actors, guard, bumped_by)
CROSS JOIN LATERAL unnest(m.froms) AS f
CROSS JOIN LATERAL unnest(m.tos) AS t
CROSS JOIN LATERAL unnest(m.actors) AS a;
SELECT app.apply_rls_template('app.ledger_transitions'::regclass, 'I');

-- One row per external effect (a publish, an edit, a delete, a reply). Its state moves only along the seeded table, which
-- the transition trigger of a later step enforces from `last_actor`, the actor of the latest move. The target is exactly
-- one of three ids (a variant now; a reply target or a moderation target arrive with the inbox, which replaces both target
-- checks), and a unique index lets one non-terminal operation hold a target at a time. A variant or a channel with an
-- operation cannot be deleted. Columns that belong to one state only are checked against it.
CREATE TABLE app.operations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  target_kind text NOT NULL DEFAULT 'variant' CHECK (target_kind = 'variant'),
  variant_id uuid,
  reply_target_id uuid,
  moderation_target_id uuid,
  channel_id uuid NOT NULL,
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 64),
  queue text NOT NULL CHECK (char_length(queue) <= 96 AND (queue LIKE 'publish.%' OR queue LIKE 'reconcile.%')),
  kind text NOT NULL CHECK (kind IN ('publish', 'edit', 'delete', 'reply')),
  part_index integer NOT NULL DEFAULT 0 CHECK (part_index >= 0),
  depends_on_operation_id uuid,
  state text NOT NULL CHECK (state IN ('pending', 'claimed', 'processing', 'dispatching', 'provider_accepted',
    'retry_wait', 'paused', 'blocked_reconnect', 'unknown_external_state', 'reconciling', 'needs_human', 'unverified',
    'published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')),
  effect text NOT NULL DEFAULT 'none' CHECK (effect IN ('none', 'possible', 'confirmed')),
  reason_code text,
  due_at timestamptz NOT NULL,
  lateness_deadline timestamptz NOT NULL,
  blocked_since timestamptz,
  blocked_total interval NOT NULL DEFAULT interval '0',
  idempotency_marker text NOT NULL CHECK (char_length(idempotency_marker) BETWEEN 1 AND 255),
  frozen_version_id uuid,
  frozen_snapshot_hash bytea CHECK (octet_length(frozen_snapshot_hash) = 32),
  approval_grant_id uuid,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_owner text CHECK (char_length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  lease_seconds integer CHECK (lease_seconds > 0),
  step_cursor text CHECK (step_cursor ~ '^(prepare:[0-9]{1,3}|await_processing|commit|done)$'),
  provider_refs jsonb NOT NULL DEFAULT '{}' CHECK (
    jsonb_typeof(provider_refs) = 'object' AND octet_length(provider_refs::text) <= 65536),
  next_attempt_at timestamptz,
  next_check_at timestamptz,
  poll_deadline timestamptz,
  processing_deadline timestamptz,
  unverified_until timestamptz,
  next_escalation_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  external_id text CHECK (char_length(external_id) <= 512),
  supersedes_operation_id uuid,
  superseded_by_operation_id uuid,
  requested_by uuid NOT NULL,
  last_actor text NOT NULL CHECK (last_actor IN ('S', 'W', 'P', 'R', 'E', 'U', 'X')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  CONSTRAINT operations_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT operations_marker_key UNIQUE (workspace_id, idempotency_marker),
  CONSTRAINT operations_target_count_check CHECK (num_nonnulls(variant_id, reply_target_id, moderation_target_id) = 1),
  CONSTRAINT operations_frozen_check CHECK ((frozen_version_id IS NULL) = (frozen_snapshot_hash IS NULL)),
  -- The reason a state carries, from the reason table of the transition table: only the states that list one may hold it,
  -- and a blocked operation always holds the state it is restored to.
  CONSTRAINT operations_reason_check CHECK (CASE state
    WHEN 'paused' THEN reason_code IS NULL OR reason_code IN ('quota', 'entitlement', 'provider_cooldown',
      'capability_withdrawn', 'api_sunset', 'channel_disabled')
    WHEN 'blocked_reconnect' THEN coalesce(reason_code IN ('pending', 'provider_accepted', 'unknown_external_state'), false)
    WHEN 'provider_accepted' THEN reason_code IS NULL OR reason_code = 'awaiting_user_action'
    WHEN 'needs_human' THEN reason_code IS NULL OR reason_code IN ('past_due_after_reconnect', 'awaiting_user_timeout',
      'media_unreachable')
    WHEN 'cancelled' THEN reason_code IS NULL OR reason_code IN ('policy', 'workspace_deleted')
    ELSE reason_code IS NULL END),
  CONSTRAINT operations_lease_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR state IN ('claimed', 'dispatching', 'reconciling', 'processing', 'provider_accepted')),
  CONSTRAINT operations_blocked_check CHECK ((blocked_since IS NOT NULL) = (state = 'blocked_reconnect')),
  CONSTRAINT operations_processing_deadline_check CHECK (
    processing_deadline IS NULL OR state IN ('processing', 'blocked_reconnect')),
  CONSTRAINT operations_poll_deadline_check CHECK (
    poll_deadline IS NULL OR state IN ('provider_accepted', 'blocked_reconnect')),
  FOREIGN KEY (workspace_id, variant_id) REFERENCES app.post_variants (workspace_id, id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES app.channels (workspace_id, id),
  FOREIGN KEY (workspace_id, frozen_version_id) REFERENCES app.post_versions (workspace_id, id),
  FOREIGN KEY (workspace_id, depends_on_operation_id) REFERENCES app.operations (workspace_id, id),
  FOREIGN KEY (workspace_id, supersedes_operation_id) REFERENCES app.operations (workspace_id, id),
  FOREIGN KEY (workspace_id, superseded_by_operation_id) REFERENCES app.operations (workspace_id, id)
);
-- The keys to the variant and the channel are checked on every delete of either, so each has an index to find its rows.
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operations_variant_idx ON app.operations (workspace_id, variant_id);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operations_channel_idx ON app.operations (workspace_id, channel_id);
-- R1: one operation per target outside the terminal states; a terminal state frees the slot.
-- shoutory:accepted-lock new empty table in this file
CREATE UNIQUE INDEX operations_target_key ON app.operations (
  workspace_id, target_kind, coalesce(variant_id, reply_target_id, moderation_target_id))
  WHERE state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome');
-- A part of a variant is published once.
-- shoutory:accepted-lock new empty table in this file
CREATE UNIQUE INDEX operations_settled_key ON app.operations (workspace_id, variant_id, part_index)
  WHERE kind = 'publish' AND state = 'published';
-- The scans of the claim, the poll and the reconcile, the lease sweep and the escalation.
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operations_claim_idx ON app.operations (queue, next_attempt_at) WHERE state = 'pending';
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operations_check_idx ON app.operations (queue, next_check_at)
  WHERE state IN ('processing', 'provider_accepted', 'unknown_external_state');
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operations_lease_idx ON app.operations (lease_expires_at) WHERE lease_owner IS NOT NULL;
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operations_escalation_idx ON app.operations (next_escalation_at)
  WHERE state IN ('needs_human', 'unverified');
SELECT app.apply_rls_template('app.operations'::regclass, 'W');

-- The exact object of each medium an operation sends: the derivative (or the original, when the provider takes it as it is)
-- and its hash, so a later edit of the library never changes what a published post was made from. It goes with its operation.
CREATE TABLE app.operation_media (
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 31),
  media_id uuid NOT NULL,
  derivative_id uuid,
  derivative_sha256 bytea NOT NULL CHECK (octet_length(derivative_sha256) = 32),
  pull_url_expires_at timestamptz,
  PRIMARY KEY (workspace_id, operation_id, position),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES app.operations (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, media_id) REFERENCES app.media_assets (workspace_id, id),
  FOREIGN KEY (workspace_id, derivative_id) REFERENCES app.media_derivatives (workspace_id, id)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operation_media_asset_idx ON app.operation_media (workspace_id, media_id);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operation_media_derivative_idx ON app.operation_media (workspace_id, derivative_id)
  WHERE derivative_id IS NOT NULL;
SELECT app.apply_rls_template('app.operation_media'::regclass, 'W');

-- The calls the ledger made for an operation, one row per attempt and step: written once, never changed.
CREATE TABLE app.operation_attempts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  step text NOT NULL CHECK (step IN ('prepare', 'commit', 'poll', 'read_back')),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  effect_started_at timestamptz,
  finished_at timestamptz,
  request_fingerprint text CHECK (char_length(request_fingerprint) <= 128),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  error_class text CHECK (char_length(error_class) <= 64),
  provider_code text CHECK (char_length(provider_code) <= 128),
  effect text NOT NULL CHECK (effect IN ('none', 'possible', 'confirmed')),
  retry_after_ms integer CHECK (retry_after_ms >= 0),
  response_excerpt text CHECK (char_length(response_excerpt) <= 2000),
  CONSTRAINT operation_attempts_number_key UNIQUE (workspace_id, operation_id, attempt_no),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES app.operations (workspace_id, id) ON DELETE CASCADE
);
SELECT app.apply_rls_template('app.operation_attempts'::regclass, 'A');

-- What the provider or a person said about the outcome: a receipt is the provider's own answer to the call, a read-back a
-- later independent read. Written once, never changed.
CREATE TABLE app.operation_evidence (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  part_index integer NOT NULL DEFAULT 0 CHECK (part_index >= 0),
  kind text NOT NULL CHECK (kind IN ('accepted', 'verified', 'observed', 'absent', 'human_confirmed', 'edit_applied',
    'removed')),
  level text NOT NULL CHECK (level IN ('human', 'receipt', 'poll_status', 'webhook', 'read_back')),
  outcome_kind text CHECK (outcome_kind IN ('post', 'draft_delivered', 'scheduled_at_provider')),
  external_id text CHECK (char_length(external_id) <= 512),
  permalink text CHECK (char_length(permalink) <= 2048),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 64),
  CONSTRAINT operation_evidence_workspace_id_key UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES app.operations (workspace_id, id) ON DELETE CASCADE
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operation_evidence_operation_idx ON app.operation_evidence (workspace_id, operation_id, observed_at);
SELECT app.apply_rls_template('app.operation_evidence'::regclass, 'A');

-- What a person decided about an operation that automation could not settle. Written once, never changed.
CREATE TABLE app.operation_resolutions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('attest_published', 'attest_not_executed', 'supersede', 'dismiss', 'publish_late',
    'reschedule', 'drop', 'confirm_removed')),
  actor uuid NOT NULL,
  ack_text text CHECK (char_length(ack_text) <= 2000),
  step_up_at timestamptz,
  absence_evidence_id uuid,
  note text CHECK (char_length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES app.operations (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, absence_evidence_id) REFERENCES app.operation_evidence (workspace_id, id)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operation_resolutions_operation_idx ON app.operation_resolutions (workspace_id, operation_id);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX operation_resolutions_absence_idx ON app.operation_resolutions (workspace_id, absence_evidence_id)
  WHERE absence_evidence_id IS NOT NULL;
SELECT app.apply_rls_template('app.operation_resolutions'::regclass, 'A');

-- Entitlement usage reserved when an operation is admitted, booked when the provider accepts and released when nothing
-- happened. Template D: no runtime role reads or writes it, only the definers.
CREATE TABLE app.usage_reservations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES app.organizations (id),
  operation_id uuid NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 64),
  amount integer NOT NULL CHECK (amount > 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'booked', 'released')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT usage_reservations_key UNIQUE (workspace_id, operation_id, key),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES app.operations (workspace_id, id) ON DELETE CASCADE
);
SELECT app.apply_rls_template('app.usage_reservations'::regclass, 'D');

-- The runtime roles read the ledger and write nothing; the reservations and the transition table have no runtime grant.
GRANT SELECT ON app.operations, app.operation_media, app.operation_attempts, app.operation_evidence,
  app.operation_resolutions TO shoutory_app, shoutory_worker;

-- The definer role holds only what the two guards, the garbage collection of media and the purge of expired rows read or
-- delete, each under the purpose of the function that does it. It writes no ledger table here.
GRANT SELECT ON app.operations, app.operation_media, app.ledger_transitions TO shoutory_definer;
GRANT SELECT, DELETE ON app.operation_attempts, app.usage_reservations TO shoutory_definer;
CALL app.grant_purposes('ledger_transitions', 'SELECT', ARRAY['ledger_guard']);
CALL app.grant_purposes('post_variants', 'SELECT', ARRAY['ledger_guard']);
CALL app.grant_purposes('operations', 'SELECT', ARRAY['media_gc_candidates', 'purge_expired']);
CALL app.grant_purposes('operation_media', 'SELECT', ARRAY['media_gc_candidates']);
CALL app.grant_purposes('post_media', 'SELECT', ARRAY['media_gc_candidates']);
CALL app.grant_purposes('operation_attempts', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('operation_attempts', 'DELETE', ARRAY['purge_expired']);
CALL app.grant_purposes('usage_reservations', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('usage_reservations', 'DELETE', ARRAY['purge_expired']);

-- The guards are created by the definer role, which needs the right to attach them; the right goes again after.
GRANT TRIGGER ON app.operations TO shoutory_definer;
SET ROLE shoutory_definer;

-- Every insert and every change of state of an operation must be a move of the seeded table for the actor named in
-- `last_actor` (an insert is a move from `none`), whoever runs the statement; any other is refused with SH409 and nothing
-- changes. An insert starts with no effect and token 0. A change that leaves the state as it is passes, unless it brings an
-- effect that may have happened back to none or lowers the token. A move the seed marks as raising the fencing token
-- raises it here (a move two seed rows name raises it if either does), any other move leaves it as it was, and a move
-- into a terminal state sets `settled_at`. A move into `published` or `provider_accepted` sets `effect = 'confirmed'`.
-- An operation whose effect is possible or confirmed may not fall back to none except by the rows that prove nothing
-- happened (19, 20, 21, 24, 36, 42, 44); the proof itself is read by the definers that write the attempts.
CREATE FUNCTION app.ledger_guard()
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

-- A publish for a variant that is settled (its parts all published) is refused at insert, unless it names the operation
-- it supersedes: the one way a settled variant is published again. Other kinds (an edit) are not refused.
CREATE FUNCTION app.ledger_settled_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF NEW.kind <> 'publish' OR NEW.supersedes_operation_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM set_config('app.job_purpose', 'ledger_guard', true);
  IF EXISTS (SELECT 1 FROM app.post_variants AS v
      WHERE v.workspace_id = NEW.workspace_id AND v.id = NEW.variant_id AND v.schedule_state = 'settled') THEN
    RAISE EXCEPTION 'ledger_settled_guard: the variant is settled' USING ERRCODE = 'SH409';
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEW;
END
$$;

CREATE TRIGGER operations_a_ledger_guard BEFORE INSERT OR UPDATE ON app.operations
  FOR EACH ROW EXECUTE FUNCTION app.ledger_guard();
CREATE TRIGGER operations_b_settled_guard BEFORE INSERT ON app.operations
  FOR EACH ROW EXECUTE FUNCTION app.ledger_settled_guard();

REVOKE ALL ON FUNCTION app.ledger_guard(), app.ledger_settled_guard() FROM PUBLIC;

-- The assets whose objects the garbage collection may remove, for a job, in the workspaces of the job: a pending upload
-- older than 24 hours; a deleted asset 30 days after its deletion whose object is still stored; and a ready asset 30 days
-- old that no post uses. An asset in the library is never a candidate, and neither is one an operation pins: every state
-- pins its media except the terminal states that sent nothing more (published, failed, cancelled, missed), and a superseded
-- operation pins it while its late evidence is watched (no end recorded, or until `unverified_until`). A saved version's snapshot is not a
-- use. The function is the 0016 one with the third arm and the two exclusions; its limit rules and its job-only call stay.
CREATE OR REPLACE FUNCTION app.media_gc_candidates(lim integer)
RETURNS TABLE (workspace_id uuid, asset_id uuid, object_key text, arm text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'job' THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  IF media_gc_candidates.lim IS NULL OR media_gc_candidates.lim NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'media_gc_candidates: the limit is 1 to 500' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'media_gc_candidates', true);
  RETURN QUERY
    WITH pinned AS (
      SELECT m.workspace_id, m.media_id FROM app.operation_media AS m
        JOIN app.operations AS o ON o.workspace_id = m.workspace_id AND o.id = m.operation_id
        WHERE m.workspace_id = ANY (app.ws_ids())
          AND (o.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')
            OR (o.state = 'superseded_after_unknown_outcome'
              AND (o.unverified_until IS NULL OR o.unverified_until > clock_timestamp())))
    )
    SELECT u.workspace_id, u.asset_id, u.object_key, u.arm FROM (
      SELECT a.workspace_id, a.id AS asset_id, a.object_key, 'pending_upload'::text AS arm
        FROM app.media_assets AS a
        WHERE a.workspace_id = ANY (app.ws_ids()) AND a.state = 'pending_upload'
          AND a.created_at <= clock_timestamp() - interval '24 hours'
      UNION ALL
      SELECT a.workspace_id, a.id, a.object_key, 'deleted'::text
        FROM app.media_assets AS a
        WHERE a.workspace_id = ANY (app.ws_ids()) AND a.state = 'deleted' AND a.object_removed_at IS NULL
          AND a.deleted_at <= clock_timestamp() - interval '30 days' AND NOT a.in_library
          AND NOT EXISTS (SELECT 1 FROM pinned AS p WHERE p.workspace_id = a.workspace_id AND p.media_id = a.id)
      UNION ALL
      SELECT a.workspace_id, a.id, a.object_key, 'unreferenced'::text
        FROM app.media_assets AS a
        WHERE a.workspace_id = ANY (app.ws_ids()) AND a.state = 'ready' AND NOT a.in_library
          AND a.created_at <= clock_timestamp() - interval '30 days'
          AND NOT EXISTS (SELECT 1 FROM app.post_media AS pm WHERE pm.workspace_id = a.workspace_id AND pm.media_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM pinned AS p WHERE p.workspace_id = a.workspace_id AND p.media_id = a.id)
    ) AS u ORDER BY u.asset_id LIMIT media_gc_candidates.lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;
RESET ROLE;
REVOKE TRIGGER ON app.operations FROM shoutory_definer;

-- The attempts of an operation are removed a year after it settled (an operation still open has no settled time, so its
-- attempts stay), and a usage reservation 13 months after it was made (the 0016 way of seeding the registry, under a
-- policy that exists only for this statement).
CREATE POLICY retention_seed_insert ON app.retention_classes FOR INSERT TO shoutory_owner WITH CHECK (true);
INSERT INTO app.retention_classes (class, table_name, kind, event_column, retain, partition_unit) VALUES
  ('app.operation_attempts', 'app.operation_attempts', 'window',
    '(SELECT o.settled_at FROM app.operations AS o WHERE o.workspace_id = operation_attempts.workspace_id AND o.id = operation_attempts.operation_id)',
    interval '1 year', NULL),
  ('app.usage_reservations', 'app.usage_reservations', 'window', 'created_at', interval '13 months', NULL);
DROP POLICY retention_seed_insert ON app.retention_classes;
