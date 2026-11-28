-- The operation of a first publish part takes the target's publish-now flag with it as its priority, and admission
-- clears the flag on the target first: a later reschedule of the same target has no priority.
SET ROLE shoutory_definer;

CREATE OR REPLACE FUNCTION app.ledger_admit_target(
  p_ws uuid, p_variant uuid, p_channel uuid, p_provider text, p_kind text, p_part integer, p_parent uuid,
  p_due timestamptz, p_missed boolean, p_requested_by uuid, p_lease integer, p_version uuid, p_marker text,
  p_pin boolean, p_reserve boolean, p_audit text, p_request text, p_ip bytea)
RETURNS TABLE (new_operation uuid, new_state text)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tolerance interval;
  org uuid;
  ch text;
  st text;
  op_reason text;
  digest bytea;
  frozen uuid;
  first_now boolean;
BEGIN
  IF p_kind = 'publish' AND p_part = 0 THEN
    UPDATE app.post_variants AS v SET publish_now = false
      WHERE v.workspace_id = p_ws AND v.id = p_variant AND v.publish_now
      RETURNING true INTO first_now;
  END IF;
  SELECT w.lateness_tolerance, w.organization_id INTO tolerance, org FROM app.workspaces AS w WHERE w.id = p_ws;
  SELECT c.connection_state INTO ch FROM app.channels AS c WHERE c.workspace_id = p_ws AND c.id = p_channel FOR SHARE;
  IF p_missed THEN
    st := 'missed';
  ELSIF ch = 'connected' THEN
    st := 'pending';
  ELSIF ch = 'disabled' THEN
    st := 'paused'; op_reason := 'channel_disabled';
  ELSE
    st := 'blocked_reconnect'; op_reason := 'pending';
  END IF;
  SELECT pv.snapshot_hash INTO digest FROM app.post_versions AS pv WHERE pv.workspace_id = p_ws AND pv.id = p_version;
  frozen := CASE WHEN digest IS NOT NULL THEN p_version END;
  new_operation := app.operation_insert(p_ws, jsonb_strip_nulls(jsonb_build_object(
    'variant_id', p_variant, 'channel_id', p_channel, 'provider_id', p_provider, 'queue', 'publish.' || p_provider,
    'kind', p_kind, 'part_index', p_part, 'depends_on_operation_id', p_parent, 'state', st, 'reason_code', op_reason,
    'due_at', p_due, 'lateness_deadline', p_due + tolerance, 'next_attempt_at', p_due,
    'blocked_since', CASE WHEN st = 'blocked_reconnect' THEN clock_timestamp() END,
    'idempotency_marker', p_marker, 'requested_by', p_requested_by, 'lease_seconds', p_lease,
    'priority', coalesce(first_now, false),
    'frozen_version_id', frozen, 'frozen_snapshot_hash', encode(digest, 'hex'))), 'S');
  IF st <> 'missed' THEN
    IF p_pin THEN
      PERFORM app.operation_media_lock(p_ws, frozen, new_operation);
      PERFORM app.operation_media_pin(p_ws, new_operation, frozen);
    END IF;
    IF p_reserve THEN
      INSERT INTO app.usage_reservations (workspace_id, organization_id, operation_id, key, amount)
        VALUES (p_ws, org, new_operation, 'posts_per_month', 1);
    END IF;
  END IF;
  INSERT INTO app.outbox (workspace_id, type, payload)
    VALUES (p_ws, 'operation.admitted', jsonb_build_object('operation_id', new_operation, 'state', st));
  IF p_audit IS NOT NULL THEN
    PERFORM app.audit_insert(p_audit, 'operation', new_operation::text, p_request, p_ip,
      jsonb_build_object('kind', p_kind, 'variant_id', p_variant));
  END IF;
  new_state := st;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION app.ledger_admit_target(uuid, uuid, uuid, text, text, integer, uuid, timestamptz, boolean,
  uuid, integer, uuid, text, boolean, boolean, text, text, bytea) FROM PUBLIC;

RESET ROLE;
