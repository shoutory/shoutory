-- An outbox event that keeps failing ends dead: it is not claimed again, it leaves the readiness lag, and it no longer
-- keeps its partition from being dropped. The cap of five attempts lives in SQL only, as one constant in each of the two functions that apply it.
DROP FUNCTION app.outbox_claim(integer, text[], text[]);

SET ROLE shoutory_definer;
ALTER TABLE app.outbox ADD COLUMN dead_at timestamptz;

-- A claim past the cap ends the row instead of delivering it: a worker that crashes in every attempt cannot loop.
CREATE FUNCTION app.outbox_claim(lim integer, only_types text[] DEFAULT NULL, skip_types text[] DEFAULT NULL)
RETURNS TABLE (id uuid, created_at text, type text, workspace_id uuid, payload jsonb, attempts integer, dead boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  cap constant integer := 5;
BEGIN
  IF lim IS NULL OR lim NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'outbox_claim refuses this limit' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'outbox_claim', true);
  RETURN QUERY
    WITH due AS (
      SELECT o.created_at, o.id FROM app.outbox AS o
      WHERE o.dispatched_at IS NULL AND o.dead_at IS NULL
        AND (o.claimed_until IS NULL OR o.claimed_until < clock_timestamp())
        AND o.xid < pg_snapshot_xmin(pg_current_snapshot())
        AND (outbox_claim.only_types IS NULL OR o.type = ANY (outbox_claim.only_types))
        AND (outbox_claim.skip_types IS NULL OR o.type <> ALL (outbox_claim.skip_types))
      ORDER BY o.xid, o.id LIMIT outbox_claim.lim FOR UPDATE SKIP LOCKED),
    moved AS (
      UPDATE app.outbox AS o SET
        attempts = CASE WHEN o.attempts >= cap THEN o.attempts ELSE o.attempts + 1 END,
        claimed_until = CASE WHEN o.attempts >= cap THEN NULL ELSE clock_timestamp() + interval '5 minutes' END,
        dead_at = CASE WHEN o.attempts >= cap THEN clock_timestamp() END
      FROM due WHERE o.created_at = due.created_at AND o.id = due.id
      RETURNING o.id, o.created_at, o.xid, o.type, o.workspace_id, o.payload, o.attempts, o.dead_at IS NOT NULL AS dead)
    SELECT m.id, to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), m.type, m.workspace_id,
      m.payload, m.attempts, m.dead
    FROM moved AS m ORDER BY m.xid, m.id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- False means the attempt is no longer the row's current one, so it changes nothing. The row ends dead when the
-- caller says no handler will ever take it, or when this attempt is the last one allowed.
CREATE FUNCTION app.outbox_fail(id uuid, created_at text, attempt integer, final boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  written bigint;
  cap constant integer := 5;
BEGIN
  PERFORM set_config('app.job_purpose', 'outbox_fail', true);
  UPDATE app.outbox AS o SET dead_at = CASE WHEN outbox_fail.final OR o.attempts >= cap THEN clock_timestamp() END,
      claimed_until = CASE WHEN outbox_fail.final OR o.attempts >= cap THEN NULL ELSE o.claimed_until END
    WHERE o.created_at = outbox_fail.created_at::timestamptz AND o.id = outbox_fail.id
      AND o.attempts = outbox_fail.attempt AND o.dispatched_at IS NULL AND o.dead_at IS NULL;
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
    FROM app.outbox AS o WHERE o.dispatched_at IS NULL AND o.dead_at IS NULL AND o.type <> 'media.uploaded';
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN lag;
END
$$;

-- A leaf of the outbox is kept while it holds an open event that is not dead. A dropped audit leaf takes the chain
-- heads of its UTC days with it, so the heads never outlive their log.
CREATE OR REPLACE FUNCTION app.purge_expired(class text)
RETURNS TABLE (removed bigint, skipped text[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  r app.retention_classes;
  leaf record;
  open_events boolean;
  batch_key text;
BEGIN
  removed := 0;
  skipped := ARRAY[]::text[];
  PERFORM set_config('app.job_purpose', 'purge_expired', true);
  SELECT k.* INTO r FROM app.retention_classes AS k WHERE k.class = purge_expired.class;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown retention class' USING ERRCODE = '22023';
  END IF;
  IF r.kind = 'window' THEN
    batch_key := CASE WHEN has_table_privilege(r.table_name::regclass, 'SELECT') THEN 'ctid' ELSE 'id' END;
    EXECUTE format(
      'DELETE FROM %1$s WHERE %2$s IN (SELECT %2$s FROM %1$s WHERE (%3$s) < clock_timestamp() - %4$L::interval LIMIT 5000)',
      r.table_name::regclass, batch_key, r.event_column, r.retain);
    GET DIAGNOSTICS removed = ROW_COUNT;
  ELSE
    SET LOCAL lock_timeout = '2s';
    FOR leaf IN
      SELECT format('%I.%I', ns.nspname, child.relname) AS name,
        substring(pg_get_expr(child.relpartbound, child.oid) FROM 'FROM \(''([^'']+)''')::timestamptz AS lower_bound,
        substring(pg_get_expr(child.relpartbound, child.oid) FROM 'TO \(''([^'']+)''')::timestamptz AS upper_bound
      FROM pg_inherits AS i JOIN pg_class AS child ON child.oid = i.inhrelid
        JOIN pg_namespace AS ns ON ns.oid = child.relnamespace
      WHERE i.inhparent = r.table_name::regclass ORDER BY 1
    LOOP
      CONTINUE WHEN leaf.upper_bound IS NULL OR leaf.upper_bound >= clock_timestamp() - r.retain;
      IF r.table_name = 'app.outbox' THEN
        SELECT EXISTS (SELECT 1 FROM app.outbox AS o WHERE o.created_at >= leaf.lower_bound
          AND o.created_at < leaf.upper_bound AND o.dispatched_at IS NULL AND o.dead_at IS NULL) INTO open_events;
        IF open_events THEN
          skipped := skipped || leaf.name;
          CONTINUE;
        END IF;
      END IF;
      EXECUTE format('DROP TABLE %s', leaf.name);
      IF r.table_name = 'app.audit_logs' THEN
        DELETE FROM app.audit_heads AS h WHERE h.day >= (leaf.lower_bound AT TIME ZONE 'UTC')::date
          AND h.day < (leaf.upper_bound AT TIME ZONE 'UTC')::date;
      END IF;
      removed := removed + 1;
    END LOOP;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEXT;
END
$$;

-- The tables belong to the definer, so the policies are created here in the form app.grant_purposes gives them.
CREATE POLICY outbox_fail_select ON app.outbox FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'outbox_fail');
CREATE POLICY outbox_fail_update ON app.outbox FOR UPDATE TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'outbox_fail') WITH CHECK ((SELECT app.job_purpose()) = 'outbox_fail');
CREATE POLICY purge_expired_select ON app.audit_heads FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'purge_expired');
CREATE POLICY purge_expired_delete ON app.audit_heads FOR DELETE TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'purge_expired');

REVOKE ALL ON FUNCTION app.outbox_claim(integer, text[], text[]), app.outbox_fail(uuid, text, integer, boolean)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_claim(integer, text[], text[]), app.outbox_fail(uuid, text, integer, boolean)
  TO shoutory_worker;
RESET ROLE;
