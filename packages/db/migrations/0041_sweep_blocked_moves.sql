CALL app.grant_purposes('operations', 'SELECT', ARRAY['sweep_blocked_moves']);
CALL app.grant_purposes('operations', 'UPDATE', ARRAY['sweep_blocked_moves']);
-- The post, its variant and the channel are locked in rank order before the operation, which needs the UPDATE policy
-- as well; the sweep never writes them.
CALL app.grant_purposes('posts', 'SELECT', ARRAY['sweep_blocked_moves']);
CALL app.grant_purposes('posts', 'UPDATE', ARRAY['sweep_blocked_moves']);
CALL app.grant_purposes('post_variants', 'SELECT', ARRAY['sweep_blocked_moves']);
CALL app.grant_purposes('post_variants', 'UPDATE', ARRAY['sweep_blocked_moves']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['sweep_blocked_moves']);
CALL app.grant_purposes('channels', 'UPDATE', ARRAY['sweep_blocked_moves']);
GRANT UPDATE (blocked_total) ON app.operations TO shoutory_definer;

SET ROLE shoutory_definer;

CREATE POLICY sweep_blocked_moves_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'sweep_blocked_moves');

-- Holds the waiting rows of a channel that needs a reconnect, and lets a held row go when its channel is connected
-- again or its reconnect deadline passed. The time a row was held is added to its lateness, so a post held before its
-- lateness ended still goes out. A row with a possible effect never goes back to pending: it returns to the state it
-- was held in, or to a person after the deadline. The channel is read again under a share lock once the row is
-- locked, so a reconnect that lands after the first read never lets the deadline cancel a post.
CREATE FUNCTION app.sweep_blocked_moves()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
  ch record;
  entered text;
  moved integer := 0;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'sweep_blocked_moves', true);
  FOR r IN
    SELECT o.id AS oid, o.workspace_id AS ows, o.state AS was, o.fencing_token AS tok, o.effect, o.reason_code AS held_as,
        o.blocked_since <= o.lateness_deadline + o.blocked_total AS in_time, o.channel_id AS cid
      FROM app.operations AS o
      JOIN app.channels AS c ON c.workspace_id = o.workspace_id AND c.id = o.channel_id
      WHERE (o.state IN ('pending', 'retry_wait', 'paused')
          AND c.connection_state IN ('needs_reconnect', 'disconnected', 'revoked_by_provider'))
        OR (o.state = 'blocked_reconnect'
          AND (c.connection_state = 'connected' OR c.reconnect_deadline <= clock_timestamp()))
      ORDER BY o.id LIMIT 500
  LOOP
    BEGIN
      PERFORM 1 FROM app.posts AS p
        JOIN app.post_variants AS v ON v.workspace_id = p.workspace_id AND v.post_id = p.id
        JOIN app.operations AS o ON o.workspace_id = v.workspace_id AND o.variant_id = v.id
        WHERE o.workspace_id = r.ows AND o.id = r.oid
        FOR NO KEY UPDATE OF p, v SKIP LOCKED;
      IF NOT FOUND THEN
        CONTINUE;
      END IF;
      SELECT c.connection_state = 'connected' AS back,
          coalesce(c.connection_state IN ('needs_reconnect', 'disconnected', 'revoked_by_provider'), false) AS away,
          coalesce(c.reconnect_deadline <= clock_timestamp(), false) AS expired
        INTO ch FROM app.channels AS c WHERE c.workspace_id = r.ows AND c.id = r.cid FOR SHARE SKIP LOCKED;
      IF NOT FOUND OR (r.was <> 'blocked_reconnect' AND NOT ch.away)
         OR (r.was = 'blocked_reconnect' AND NOT ch.back AND NOT ch.expired) THEN
        CONTINUE;
      END IF;
      PERFORM 1 FROM app.operations AS o
        WHERE o.workspace_id = r.ows AND o.id = r.oid AND o.state = r.was AND o.fencing_token = r.tok
        FOR NO KEY UPDATE SKIP LOCKED;
      IF NOT FOUND THEN
        CONTINUE;
      END IF;
      entered := CASE
        WHEN r.was <> 'blocked_reconnect' THEN 'blocked_reconnect'
        WHEN NOT ch.back THEN CASE WHEN r.effect = 'none' THEN 'cancelled' ELSE 'needs_human' END
        WHEN r.effect <> 'none' THEN CASE WHEN r.held_as = 'provider_accepted' THEN 'provider_accepted'
          ELSE 'unknown_external_state' END
        WHEN r.in_time THEN 'pending'
        ELSE 'needs_human' END;
      UPDATE app.operations AS o SET state = entered, last_actor = 'S',
          reason_code = CASE WHEN entered = 'blocked_reconnect' THEN 'pending'
            WHEN entered = 'needs_human' AND ch.back THEN 'past_due_after_reconnect' END,
          blocked_since = CASE WHEN entered = 'blocked_reconnect' THEN clock_timestamp() END,
          blocked_total = CASE WHEN r.was = 'blocked_reconnect' AND ch.back
            THEN o.blocked_total + (clock_timestamp() - o.blocked_since) ELSE o.blocked_total END,
          queue = CASE WHEN entered = 'pending' THEN 'publish.' || o.provider_id ELSE o.queue END,
          next_check_at = CASE WHEN entered IN ('unknown_external_state', 'provider_accepted') THEN clock_timestamp()
            ELSE o.next_check_at END,
          poll_deadline = CASE WHEN entered IN ('provider_accepted', 'blocked_reconnect') THEN o.poll_deadline END,
          processing_deadline = CASE WHEN entered = 'blocked_reconnect' THEN o.processing_deadline END
        WHERE o.workspace_id = r.ows AND o.id = r.oid;
      INSERT INTO app.outbox (workspace_id, type, payload)
        VALUES (r.ows, 'operation.' || entered, jsonb_build_object('operation_id', r.oid, 'from', r.was, 'to', entered));
      moved := moved + 1;
    EXCEPTION WHEN SQLSTATE 'SH409' THEN
      NULL;
    END;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
  RETURN moved;
END
$$;

REVOKE ALL ON FUNCTION app.sweep_blocked_moves() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sweep_blocked_moves() TO shoutory_worker;

RESET ROLE;
