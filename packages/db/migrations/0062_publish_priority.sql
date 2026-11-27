-- A target published with "publish now" is claimed before the older backlog of its own provider's queue. The flag lives
-- on the target until admission copies it onto the operation it makes; no queue of its own exists for it.
ALTER TABLE app.operations ADD COLUMN priority boolean NOT NULL DEFAULT false;
ALTER TABLE app.post_variants ADD COLUMN publish_now boolean NOT NULL DEFAULT false;
GRANT UPDATE (publish_now) ON app.post_variants TO shoutory_definer;

-- The insert definer reads the flag of the target, so admission, the follow-ups and the resolutions all copy it.
CALL app.grant_purposes('post_variants', 'SELECT', ARRAY['operation_insert']);
-- The claim reads the channel it claims for.
CALL app.grant_purposes('channels', 'SELECT', ARRAY['claim_operations']);

SET ROLE shoutory_definer;

CREATE OR REPLACE FUNCTION app.operation_insert(workspace_id uuid, fields jsonb, actor text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  new_id constant uuid := uuidv7();
  first_publish boolean;
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
       'requested_by', 'priority'])) THEN
    RAISE EXCEPTION 'operation_insert: an unknown key' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(v.publish_now, false) INTO first_publish FROM app.post_variants AS v
    WHERE v.workspace_id = operation_insert.workspace_id AND v.id = (operation_insert.fields ->> 'variant_id')::uuid
      AND operation_insert.fields ->> 'kind' = 'publish'
      AND coalesce((operation_insert.fields ->> 'part_index')::integer, 0) = 0;
  INSERT INTO app.operations (id, workspace_id, variant_id, channel_id, provider_id, queue, kind, part_index,
      depends_on_operation_id, state, reason_code, due_at, lateness_deadline, blocked_since, idempotency_marker,
      frozen_version_id, frozen_snapshot_hash, approval_grant_id, supersedes_operation_id, lease_seconds,
      next_attempt_at, requested_by, last_actor, priority)
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
      (operation_insert.fields ->> 'requested_by')::uuid, operation_insert.actor,
      coalesce((operation_insert.fields ->> 'priority')::boolean, false) OR coalesce(first_publish, false));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;

-- Priority first, then the oldest; a channel that is not connected is never claimed for (disconnect holds its waiting
-- operations, and a claim that raced it either came first or sees the new state).
CREATE OR REPLACE FUNCTION app.claim_operations(p_queue text, p_limit integer, p_owner text)
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
      JOIN app.channels AS c ON c.workspace_id = o.workspace_id AND c.id = o.channel_id
      WHERE o.state = 'pending' AND o.queue = p_queue AND o.next_attempt_at <= clock_timestamp()
        AND clock_timestamp() <= o.lateness_deadline + o.blocked_total AND c.connection_state = 'connected'
      ORDER BY o.priority DESC, o.next_attempt_at, o.id LIMIT p_limit FOR UPDATE OF o SKIP LOCKED
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

RESET ROLE;
