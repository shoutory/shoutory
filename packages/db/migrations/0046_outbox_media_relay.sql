-- An upload's event runs for up to half an hour on its own relay: the claim filters by type, a heartbeat keeps the
-- live claim, and the readiness lag leaves uploads out so one long video never takes a healthy api out of rotation.
DROP FUNCTION app.outbox_claim(integer);

SET ROLE shoutory_definer;

-- Only events below the visibility horizon (the oldest transaction still running) are claimed, so a late commit is
-- never skipped. A row whose lease lapsed is claimable again; its attempt count is the fencing token of the mark.
-- A NULL list filters nothing.
CREATE FUNCTION app.outbox_claim(lim integer, only_types text[] DEFAULT NULL, skip_types text[] DEFAULT NULL)
RETURNS TABLE (id uuid, created_at text, type text, workspace_id uuid, payload jsonb, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF lim IS NULL OR lim NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'outbox_claim refuses this limit' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'outbox_claim', true);
  RETURN QUERY
    WITH due AS (
      SELECT o.created_at, o.id FROM app.outbox AS o
      WHERE o.dispatched_at IS NULL AND (o.claimed_until IS NULL OR o.claimed_until < clock_timestamp())
        AND o.xid < pg_snapshot_xmin(pg_current_snapshot())
        AND (outbox_claim.only_types IS NULL OR o.type = ANY (outbox_claim.only_types))
        AND (outbox_claim.skip_types IS NULL OR o.type <> ALL (outbox_claim.skip_types))
      ORDER BY o.xid, o.id LIMIT outbox_claim.lim FOR UPDATE SKIP LOCKED),
    moved AS (
      UPDATE app.outbox AS o SET claimed_until = clock_timestamp() + interval '5 minutes', attempts = o.attempts + 1
      FROM due WHERE o.created_at = due.created_at AND o.id = due.id
      RETURNING o.id, o.created_at, o.xid, o.type, o.workspace_id, o.payload, o.attempts)
    SELECT m.id, to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), m.type, m.workspace_id,
      m.payload, m.attempts
    FROM moved AS m ORDER BY m.xid, m.id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- False means the claim is no longer this attempt's: re-claimed, lapsed or done. A lapsed lease is not revived,
-- since another claimer may take the row at any moment after it lapsed.
CREATE FUNCTION app.outbox_heartbeat(id uuid, created_at text, attempt integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  written bigint;
BEGIN
  PERFORM set_config('app.job_purpose', 'outbox_heartbeat', true);
  UPDATE app.outbox AS o SET claimed_until = clock_timestamp() + interval '5 minutes'
    WHERE o.created_at = outbox_heartbeat.created_at::timestamptz AND o.id = outbox_heartbeat.id
      AND o.attempts = outbox_heartbeat.attempt AND o.dispatched_at IS NULL
      AND o.claimed_until >= clock_timestamp();
  GET DIAGNOSTICS written = ROW_COUNT;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN written = 1;
END
$$;

CREATE OR REPLACE FUNCTION app.outbox_lag()
RETURNS double precision
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  lag double precision;
BEGIN
  PERFORM set_config('app.job_purpose', 'outbox_lag', true);
  SELECT coalesce(extract(epoch FROM clock_timestamp() - min(o.created_at)), 0)::double precision INTO lag
    FROM app.outbox AS o WHERE o.dispatched_at IS NULL AND o.type <> 'media.uploaded';
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN lag;
END
$$;

REVOKE ALL ON FUNCTION app.outbox_claim(integer, text[], text[]), app.outbox_heartbeat(uuid, text, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_claim(integer, text[], text[]), app.outbox_heartbeat(uuid, text, integer)
  TO shoutory_worker;

-- The outbox belongs to the definer, so the policies are created here in the form app.grant_purposes gives them.
CREATE POLICY outbox_heartbeat_select ON app.outbox FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'outbox_heartbeat');
CREATE POLICY outbox_heartbeat_update ON app.outbox FOR UPDATE TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'outbox_heartbeat') WITH CHECK ((SELECT app.job_purpose()) = 'outbox_heartbeat');
RESET ROLE;
