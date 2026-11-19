-- The event outbox, retention, worker liveness, the mail sender's claim and the sign-up gate.
--
-- Everything here is reached only through definer functions: no runtime role holds a privilege on a table of this
-- file. A claim moves a row under a lease and a mark is fenced by the attempt count the claim handed out, so a worker
-- whose lease lapsed cannot overwrite the outcome of the one that took the row over.

-- The mail sender's lease. A row moves to `sending` with a lease; a lapsed lease makes it claimable again, sealed link
-- included. `attempts` already exists; the sealed columns become NULL when the row ends (sent or failed).
ALTER TABLE app.email_outbox ADD COLUMN claimed_until timestamptz;
-- shoutory:accepted-lock new empty table at this point of the install
CREATE INDEX email_outbox_pending_idx ON app.email_outbox (next_attempt_at) WHERE state = 'pending';
-- The claim also looks for sending rows whose lease has lapsed.
-- shoutory:accepted-lock new empty table at this point of the install
CREATE INDEX email_outbox_sending_idx ON app.email_outbox (claimed_until) WHERE state = 'sending';

-- One policy per purpose, table and command, named <purpose>_<command>, open to its purpose alone. A migration tool
-- that later migrations reuse (0010 dropped its own copy, and an applied file is never edited).
CREATE PROCEDURE app.grant_purposes(tbl text, cmd text, purposes text[])
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  p text;
  test constant text := '(SELECT app.job_purpose()) = %L';
BEGIN
  FOREACH p IN ARRAY purposes LOOP
    EXECUTE format('CREATE POLICY %I ON app.%I FOR %s TO shoutory_definer %s', p || '_' || lower(cmd), tbl, cmd,
      CASE cmd
        WHEN 'INSERT' THEN format('WITH CHECK (' || test || ')', p)
        WHEN 'UPDATE' THEN format('USING (' || test || ') WITH CHECK (' || test || ')', p, p)
        ELSE format('USING (' || test || ')', p)
      END);
  END LOOP;
END
$$;

-- The event outbox: one row per event, written inside the business transaction. `xid` is the writer's
-- transaction id, so a reader that stops below the snapshot horizon never skips a row that commits late. No producer
-- exists yet; the first definer that writes shown state adds its own insert purpose.
CREATE TABLE app.outbox (
  id uuid NOT NULL DEFAULT uuidv7(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  workspace_id uuid,
  type text NOT NULL CHECK (type ~ '^[a-z]+(\.[a-z_]+)+$' AND char_length(type) <= 64),
  payload jsonb NOT NULL DEFAULT '{}' CHECK (octet_length(payload::text) <= 16384),
  dispatched_at timestamptz,
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);
-- shoutory:accepted-lock new empty partitioned table in this file
CREATE INDEX outbox_xid_idx ON app.outbox (xid, id) WHERE dispatched_at IS NULL;

-- The worker liveness table: one row per worker process, beaten every 30 s through worker_heartbeat.
CREATE TABLE app.worker_heartbeats (
  worker_id text PRIMARY KEY CHECK (char_length(worker_id) BETWEEN 1 AND 128),
  role text NOT NULL CHECK (role IN ('api', 'worker', 'all')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Addresses that receive no marketing mail. A digest is the keyed hash of the lower-cased address; a hard bounce, a
-- complaint or an unsubscribe adds one. The first reason stays.
CREATE TABLE app.email_suppressions (
  email_digest text PRIMARY KEY CHECK (email_digest ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'unsubscribe')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The retention registry (data-model 1.6 and 1.7). `purge_expired` and `ensure_partitions` read only this table.
-- `table_name` is schema-qualified. A window class deletes the rows whose `event_column` is older than `retain`;
-- `event_column` may be an expression (it is written by migrations only), and a NULL result keeps the row. A partition
-- class drops the leaves whose upper bound is older than `retain` and keeps three leaves ahead.
CREATE TABLE app.retention_classes (
  class text PRIMARY KEY CHECK (class ~ '^[a-z_.]+$'),
  table_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('window', 'partition')),
  event_column text,
  retain interval NOT NULL CHECK (retain > interval '0'),
  partition_unit text CHECK (partition_unit IN ('day', 'month')),
  CONSTRAINT retention_classes_shape_check CHECK (
    (kind = 'window' AND event_column IS NOT NULL AND partition_unit IS NULL)
    OR (kind = 'partition' AND event_column IS NULL AND partition_unit IS NOT NULL))
);
INSERT INTO app.retention_classes (class, table_name, kind, event_column, retain, partition_unit) VALUES
  ('audit_logs', 'app.audit_logs', 'partition', NULL, interval '2 years', 'month'),
  ('outbox', 'app.outbox', 'partition', NULL, interval '7 days', 'day'),
  ('email_outbox', 'app.email_outbox', 'window', 'CASE WHEN state IN (''sent'', ''failed'') THEN created_at END',
    interval '30 days', NULL),
  ('auth.session', 'auth.session', 'window', 'expires_at', interval '7 days', NULL),
  ('auth.verification', 'auth.verification', 'window', 'expires_at', interval '1 day', NULL),
  ('app.session_step_ups', 'app.session_step_ups', 'window', 'at', interval '1 day', NULL),
  ('app.invitations', 'app.invitations', 'window', 'LEAST(accepted_at, revoked_at, expires_at)',
    interval '30 days', NULL),
  ('app.rate_buckets', 'app.rate_buckets', 'window', 'refilled_at', interval '30 days', NULL),
  ('app.worker_heartbeats', 'app.worker_heartbeats', 'window', 'seen_at', interval '7 days', NULL),
  ('auth.user_unverified', 'auth.user', 'window', 'CASE WHEN NOT email_verified
    AND NOT EXISTS (SELECT 1 FROM app.workspace_members AS m WHERE m.user_id = auth."user".id)
    AND NOT EXISTS (SELECT 1 FROM app.organization_members AS o WHERE o.user_id = auth."user".id)
    AND NOT EXISTS (SELECT 1 FROM app.invitations AS i
      WHERE i.invited_by = auth."user".id OR i.accepted_by = auth."user".id)
    THEN created_at END', interval '7 days', NULL);

SELECT app.apply_rls_template('app.outbox'::regclass, 'D');
SELECT app.apply_rls_template('app.worker_heartbeats'::regclass, 'I');
SELECT app.apply_rls_template('app.email_suppressions'::regclass, 'D');
SELECT app.apply_rls_template('app.retention_classes'::regclass, 'I');

-- What the definer role may do. A row is reached only under the purpose its function sets at entry.
GRANT SELECT, INSERT, UPDATE, DELETE ON app.worker_heartbeats TO shoutory_definer;
GRANT SELECT, INSERT ON app.email_suppressions TO shoutory_definer;
GRANT SELECT ON app.retention_classes TO shoutory_definer;
GRANT UPDATE (state, attempts, next_attempt_at, claimed_until) ON app.email_outbox TO shoutory_definer;
GRANT DELETE ON app.email_outbox, app.session_step_ups, app.invitations, app.rate_buckets TO shoutory_definer;
-- The purge reads the event column and deletes; nothing else of the identity tables.
GRANT DELETE ON auth.session, auth.verification, auth."user" TO shoutory_definer;
GRANT SELECT (expires_at, id) ON auth.session, auth.verification TO shoutory_definer;
GRANT SELECT (created_at) ON auth."user" TO shoutory_definer;

CALL app.grant_purposes('outbox', 'SELECT', ARRAY['outbox_claim', 'outbox_mark', 'outbox_lag', 'purge_expired']);
CALL app.grant_purposes('workspace_members', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('organization_members', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('outbox', 'UPDATE', ARRAY['outbox_claim', 'outbox_mark']);
CALL app.grant_purposes('worker_heartbeats', 'SELECT', ARRAY['worker_heartbeat', 'worker_status', 'purge_expired']);
CALL app.grant_purposes('worker_heartbeats', 'INSERT', ARRAY['worker_heartbeat']);
CALL app.grant_purposes('worker_heartbeats', 'UPDATE', ARRAY['worker_heartbeat']);
CALL app.grant_purposes('worker_heartbeats', 'DELETE', ARRAY['purge_expired']);
CALL app.grant_purposes('email_suppressions', 'SELECT', ARRAY['email_suppression_add']);
CALL app.grant_purposes('email_suppressions', 'INSERT', ARRAY['email_suppression_add']);
CALL app.grant_purposes('retention_classes', 'SELECT', ARRAY['purge_expired', 'ensure_partitions']);
CALL app.grant_purposes('email_outbox', 'SELECT', ARRAY['email_outbox_claim', 'email_outbox_mark', 'purge_expired']);
CALL app.grant_purposes('email_outbox', 'UPDATE', ARRAY['email_outbox_claim', 'email_outbox_mark']);
CALL app.grant_purposes('email_outbox', 'DELETE', ARRAY['purge_expired']);
CALL app.grant_purposes('session_step_ups', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('session_step_ups', 'DELETE', ARRAY['purge_expired']);
CALL app.grant_purposes('invitations', 'SELECT', ARRAY['purge_expired', 'signup_gate']);
CALL app.grant_purposes('invitations', 'DELETE', ARRAY['purge_expired']);
CALL app.grant_purposes('rate_buckets', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('rate_buckets', 'DELETE', ARRAY['purge_expired']);
CALL app.grant_purposes('instance_admins', 'SELECT', ARRAY['signup_gate', 'signup_open', 'instance_settings_read']);
CALL app.grant_purposes('instance_settings', 'SELECT', ARRAY['signup_gate', 'signup_open', 'instance_settings_read']);

-- audit_logs belongs to the definer role, so its policy and its new index are made by that role. The audit read
-- route resolves its cursor row by id inside one workspace (R276).
SET ROLE shoutory_definer;
CREATE POLICY audit_chain_check_select ON app.audit_logs FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'audit_chain_check');
CREATE POLICY audit_chain_check_select ON app.audit_heads FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'audit_chain_check');
-- shoutory:accepted-lock new empty partitioned table at M0; CONCURRENTLY is not available on a partitioned parent
CREATE INDEX audit_logs_workspace_id_idx ON app.audit_logs (workspace_id, id);
RESET ROLE;

-- The one-click unsubscribe route is rate limited per client under its own scope: 20 posts in 15 minutes. The definer
-- role owns the function and the migration owner does not inherit its rights, so the replacement runs as the definer.
SET ROLE shoutory_definer;
CREATE OR REPLACE FUNCTION app.bucket_limits(scope text)
RETURNS TABLE (capacity integer, refill_seconds integer)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT l.capacity, l.refill_seconds FROM (VALUES
    ('login_account', 100, 86400),
    ('login_ip', 60, 900),
    ('verification_resend', 5, 3600),
    ('two_factor', 10, 900),
    ('password_reset', 5, 3600),
    ('totp_code', 1, 90),
    ('link_confirm', 20, 900),
    ('invite', 20, 3600),
    ('invite_accept', 10, 900),
    ('unsubscribe', 20, 900)
  ) AS l (name, capacity, refill_seconds) WHERE l.name = scope
$$;
REVOKE ALL ON FUNCTION app.bucket_limits(text) FROM PUBLIC;
RESET ROLE;

-- Keeps three leaves ahead of every partition class and gives each new leaf what its parent has. A leaf starts
-- with row security enabled and forced like its parent (a leaf read directly would otherwise skip the parent's
-- policies); the audit leaves also get the TRUNCATE trigger, both triggers ENABLE ALWAYS (R184). Never a DEFAULT
-- partition: a missing leaf fails the insert loudly and /readyz reports fewer than two leaves ahead.
--
-- Lock levels (PostgreSQL 18, https://www.postgresql.org/docs/18/ddl-partitioning.html, accessed 2026-11-19):
-- CREATE TABLE ... PARTITION OF takes ACCESS EXCLUSIVE on the partitioned parent, ATTACH PARTITION only SHARE UPDATE
-- EXCLUSIVE; DROP TABLE of a leaf and DETACH PARTITION (without CONCURRENTLY) take ACCESS EXCLUSIVE on the parent.
-- An ACCESS EXCLUSIVE request waits behind every running statement on the table and blocks all later ones, so the
-- statements run under lock_timeout = 2 s: a run that cannot get the lock fails, and the next daily run retries.
-- Concurrent callers are serialized by the scheduled job, not by SQL here.
CREATE FUNCTION app.ensure_partitions()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  c record;
  first_period timestamp;
  period timestamp;
  step interval;
  leaf text;
  made integer := 0;
BEGIN
  PERFORM set_config('app.job_purpose', 'ensure_partitions', true);
  SET LOCAL lock_timeout = '2s';
  FOR c IN SELECT k.table_name, k.partition_unit FROM app.retention_classes AS k WHERE k.kind = 'partition' LOOP
    step := CASE c.partition_unit WHEN 'day' THEN interval '1 day' ELSE interval '1 month' END;
    first_period := date_trunc(c.partition_unit, clock_timestamp() AT TIME ZONE 'UTC');
    FOR n IN 0..3 LOOP
      period := first_period + n * step;
      leaf := format('%s_%s', split_part(c.table_name, '.', 2),
        to_char(period, CASE c.partition_unit WHEN 'day' THEN 'YYYYMMDD' ELSE 'YYYY_MM' END));
      CONTINUE WHEN to_regclass(format('app.%I', leaf)) IS NOT NULL;
      EXECUTE format('CREATE TABLE app.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)', leaf, c.table_name::regclass,
        (period AT TIME ZONE 'UTC')::text, ((period + step) AT TIME ZONE 'UTC')::text);
      EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', leaf);
      EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', leaf);
      IF c.table_name = 'app.audit_logs' THEN
        EXECUTE format(
          'CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.audit_immutable()',
          leaf);
        EXECUTE format('ALTER TABLE app.%I ENABLE ALWAYS TRIGGER audit_logs_immutable', leaf);
        EXECUTE format('ALTER TABLE app.%I ENABLE ALWAYS TRIGGER audit_logs_no_truncate', leaf);
      END IF;
      made := made + 1;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN made;
END
$$;

-- Removes what one class names and answers how many rows (or leaves) went, and the leaves it kept on purpose. A window
-- class deletes at most 5000 rows whose event is older than its window per call (the scheduled job calls again until
-- fewer come back); a partition class drops each leaf whose upper bound is older than the window, except an outbox
-- leaf that still holds an undispatched event, which it skips and names. An unknown class is refused. The delete finds
-- its rows by ctid, or by id where the definer holds only column privileges (the identity tables); those tables carry
-- no row security and are owned by the authentication library. Lock levels and lock_timeout: see ensure_partitions.
CREATE FUNCTION app.purge_expired(class text)
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
          AND o.created_at < leaf.upper_bound AND o.dispatched_at IS NULL) INTO open_events;
        IF open_events THEN
          skipped := skipped || leaf.name;
          CONTINUE;
        END IF;
      END IF;
      EXECUTE format('DROP TABLE %s', leaf.name);
      removed := removed + 1;
    END LOOP;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEXT;
END
$$;

-- One beat of one worker: the first beat creates the row, later beats move `seen_at`.
CREATE FUNCTION app.worker_heartbeat(worker_id text, role text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'worker_heartbeat', true);
  INSERT INTO app.worker_heartbeats (worker_id, role)
    VALUES (worker_heartbeat.worker_id, worker_heartbeat.role)
    ON CONFLICT ON CONSTRAINT worker_heartbeats_pkey
    DO UPDATE SET seen_at = clock_timestamp(), role = EXCLUDED.role;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Every worker with whether it has gone quiet: a beat older than 90 s is stale (R304).
CREATE FUNCTION app.worker_status()
RETURNS TABLE (worker_id text, role text, started_at timestamptz, seen_at timestamptz, stale boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'worker_status', true);
  RETURN QUERY
    SELECT w.worker_id, w.role, w.started_at, w.seen_at, w.seen_at < clock_timestamp() - interval '90 seconds'
    FROM app.worker_heartbeats AS w ORDER BY w.worker_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The age in seconds of the oldest event not yet dispatched; 0 when there is none.
CREATE FUNCTION app.outbox_lag()
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
    FROM app.outbox AS o WHERE o.dispatched_at IS NULL;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN lag;
END
$$;

-- The age in seconds of the oldest due job of the queue library. Before the library's schema is installed the answer
-- is `installed = false` and no lag, never a zero. The install step grants this role SELECT on the table it reads.
CREATE FUNCTION app.job_lag()
RETURNS TABLE (installed boolean, lag_seconds double precision)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF to_regclass('pgboss.job') IS NULL THEN
    RETURN QUERY SELECT false, NULL::double precision;
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT true, coalesce(extract(epoch FROM clock_timestamp() - min(j.start_after)), 0)::double precision
     FROM pgboss.job AS j WHERE j.state IN (''created'', ''retry'') AND j.start_after <= clock_timestamp()';
END
$$;

-- Claims up to `lim` events below the visibility horizon (the oldest transaction still running), in (xid, id)
-- order, and leases them for five minutes. The handler runs after this transaction ends. A row whose lease lapsed is
-- claimable again; the attempt count it carries is the fencing token of the mark.
CREATE FUNCTION app.outbox_claim(lim integer)
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

-- Marks one event dispatched, and only if the caller still holds the claim it opened: the attempt count must match.
-- False means another claimer took the event over (or it is done); nothing changed. The creation time is the text the
-- claim returned, microseconds included, and matches exactly (a client driver would cut a timestamp to milliseconds).
CREATE FUNCTION app.outbox_mark(id uuid, created_at text, attempt integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  written bigint;
BEGIN
  PERFORM set_config('app.job_purpose', 'outbox_mark', true);
  UPDATE app.outbox AS o SET dispatched_at = clock_timestamp(), claimed_until = NULL
    WHERE o.created_at = outbox_mark.created_at::timestamptz AND o.id = outbox_mark.id
      AND o.attempts = outbox_mark.attempt AND o.dispatched_at IS NULL;
  GET DIAGNOSTICS written = ROW_COUNT;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN written = 1;
END
$$;

-- Claims up to `lim` mails that are due (pending, or sending under a lapsed lease), leases them for five minutes and
-- hands the sealed link to the sender. Delivery is at least once: a lapsed lease sends the same row again.
CREATE FUNCTION app.email_outbox_claim(lim integer)
RETURNS TABLE (
  id uuid, workspace_id uuid, recipient text, template text, locale text, vars jsonb, link_ciphertext bytea,
  link_iv bytea, link_auth_tag bytea, link_wrap_iv bytea, link_wrap_tag bytea, link_wrapped_dek bytea,
  link_key_id text, link_format_version integer, link_generation integer, link_digest text, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF lim IS NULL OR lim NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'email_outbox_claim refuses this limit' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'email_outbox_claim', true);
  -- A lapsed lease on the fifth attempt is not claimed again: the mail ends as failed and loses its sealed link.
  UPDATE app.email_outbox AS e SET state = 'failed', claimed_until = NULL, link_ciphertext = NULL, link_iv = NULL,
      link_auth_tag = NULL, link_wrap_iv = NULL, link_wrap_tag = NULL, link_wrapped_dek = NULL, link_key_id = NULL,
      link_format_version = NULL, link_generation = NULL
    WHERE e.state = 'sending' AND e.claimed_until < clock_timestamp() AND e.attempts >= 5;
  RETURN QUERY
    WITH fresh AS (
      SELECT e.id, e.next_attempt_at AS due_at FROM app.email_outbox AS e
      WHERE e.state = 'pending' AND e.next_attempt_at <= clock_timestamp()
      ORDER BY e.next_attempt_at, e.id LIMIT email_outbox_claim.lim FOR UPDATE SKIP LOCKED),
    lapsed AS (
      SELECT e.id, e.claimed_until AS due_at FROM app.email_outbox AS e
      WHERE e.state = 'sending' AND e.claimed_until < clock_timestamp()
      ORDER BY e.claimed_until, e.id LIMIT email_outbox_claim.lim FOR UPDATE SKIP LOCKED),
    due AS (
      SELECT d.id FROM (SELECT f.id, f.due_at FROM fresh AS f UNION ALL SELECT l.id, l.due_at FROM lapsed AS l) AS d
      ORDER BY d.due_at, d.id LIMIT email_outbox_claim.lim),
    moved AS (
      UPDATE app.email_outbox AS e SET state = 'sending', claimed_until = clock_timestamp() + interval '5 minutes',
        attempts = e.attempts + 1
      FROM due WHERE e.id = due.id
      RETURNING e.id, e.workspace_id, e.recipient, e.template, e.locale, e.vars, e.link_ciphertext, e.link_iv,
        e.link_auth_tag, e.link_wrap_iv, e.link_wrap_tag, e.link_wrapped_dek, e.link_key_id, e.link_format_version,
        e.link_generation, e.link_digest, e.attempts, e.next_attempt_at)
    SELECT m.id, m.workspace_id, m.recipient, m.template, m.locale, m.vars, m.link_ciphertext, m.link_iv,
      m.link_auth_tag, m.link_wrap_iv, m.link_wrap_tag, m.link_wrapped_dek, m.link_key_id, m.link_format_version,
      m.link_generation, m.link_digest, m.attempts
    FROM moved AS m ORDER BY m.next_attempt_at, m.id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Records the outcome of one send, and only for the claim the caller still holds (same attempt count). A success ends
-- the row; a failure retries after 1 minute times 2^(attempts - 1), and the fifth failure ends it as `failed`. An
-- ended row loses its sealed link and keeps the digest (NFR-SEC-26). False means the claim was lost.
CREATE FUNCTION app.email_outbox_mark(id uuid, attempt integer, ok boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  written bigint;
BEGIN
  PERFORM set_config('app.job_purpose', 'email_outbox_mark', true);
  UPDATE app.email_outbox AS e SET
      state = CASE WHEN email_outbox_mark.ok THEN 'sent' WHEN e.attempts >= 5 THEN 'failed' ELSE 'pending' END,
      next_attempt_at = CASE WHEN NOT email_outbox_mark.ok AND e.attempts < 5
        THEN clock_timestamp() + interval '1 minute' * power(2, e.attempts - 1) ELSE e.next_attempt_at END,
      claimed_until = NULL,
      link_ciphertext = CASE WHEN email_outbox_mark.ok OR e.attempts >= 5 THEN NULL ELSE e.link_ciphertext END,
      link_iv = CASE WHEN email_outbox_mark.ok OR e.attempts >= 5 THEN NULL ELSE e.link_iv END,
      link_auth_tag = CASE WHEN email_outbox_mark.ok OR e.attempts >= 5 THEN NULL ELSE e.link_auth_tag END,
      link_wrap_iv = CASE WHEN email_outbox_mark.ok OR e.attempts >= 5 THEN NULL ELSE e.link_wrap_iv END,
      link_wrap_tag = CASE WHEN email_outbox_mark.ok OR e.attempts >= 5 THEN NULL ELSE e.link_wrap_tag END,
      link_wrapped_dek = CASE WHEN email_outbox_mark.ok OR e.attempts >= 5 THEN NULL ELSE e.link_wrapped_dek END,
      link_key_id = CASE WHEN email_outbox_mark.ok OR e.attempts >= 5 THEN NULL ELSE e.link_key_id END,
      link_format_version = CASE WHEN email_outbox_mark.ok OR e.attempts >= 5 THEN NULL ELSE e.link_format_version END,
      link_generation = CASE WHEN email_outbox_mark.ok OR e.attempts >= 5 THEN NULL ELSE e.link_generation END
    WHERE e.id = email_outbox_mark.id AND e.attempts = email_outbox_mark.attempt AND e.state = 'sending';
  GET DIAGNOSTICS written = ROW_COUNT;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN written = 1;
END
$$;

-- Adds one address digest to the suppression list; a second add of the same digest changes nothing.
CREATE FUNCTION app.email_suppression_add(email_digest text, reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'email_suppression_add', true);
  INSERT INTO app.email_suppressions (email_digest, reason)
    VALUES (email_suppression_add.email_digest, email_suppression_add.reason)
    ON CONFLICT ON CONSTRAINT email_suppressions_pkey DO NOTHING;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Whether sign-up is open to anyone: while no instance admin exists (the first sign-up founds the instance) or
-- while the instance setting is on. It names no address.
CREATE FUNCTION app.signup_open()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  open_now boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'signup_open', true);
  open_now := NOT EXISTS (SELECT 1 FROM app.instance_admins AS a)
    OR EXISTS (SELECT 1 FROM app.instance_settings AS s WHERE s.key = 'signup_enabled' AND s.value = 'true'::jsonb);
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN open_now;
END
$$;

-- Whether one address may sign up: the open cases above, or a pending unexpired invitation addressed to it.
CREATE FUNCTION app.signup_gate(email text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  open_now boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'signup_gate', true);
  open_now := NOT EXISTS (SELECT 1 FROM app.instance_admins AS a)
    OR EXISTS (SELECT 1 FROM app.instance_settings AS s WHERE s.key = 'signup_enabled' AND s.value = 'true'::jsonb)
    OR EXISTS (SELECT 1 FROM app.invitations AS i WHERE i.email = lower(signup_gate.email)
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > clock_timestamp());
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN open_now;
END
$$;

-- The instance settings, for an instance admin only: a caller who is not one is refused (42501).
CREATE FUNCTION app.instance_settings_read()
RETURNS TABLE (key text, value jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
BEGIN
  PERFORM set_config('app.job_purpose', 'instance_settings_read', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user'
     OR NOT EXISTS (SELECT 1 FROM app.instance_admins AS a WHERE a.user_id = caller) THEN
    RAISE EXCEPTION 'instance_settings_read refuses a caller who is not an instance admin' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT s.key, s.value FROM app.instance_settings AS s ORDER BY s.key;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The first row of a UTC day, across its chains, whose link or hash is not what the chain contract says; no row means
-- the day verifies, an empty day included. The hash is recomputed exactly as audit_append writes it.
CREATE FUNCTION app.audit_chain_check(day date)
RETURNS TABLE (id uuid, at timestamptz, workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'audit_chain_check', true);
  RETURN QUERY
    WITH chain AS (
      SELECT l.id, l.at, l.workspace_id, l.prev_hash,
        lag(l.hash) OVER w AS before,
        -- The last row of a chain must carry the hash its head holds, when that head belongs to this day: a removed
        -- last row or a head moved by hand shows here.
        (row_number() OVER (PARTITION BY l.workspace_id ORDER BY l.at DESC, l.id DESC) = 1
          AND h.head_hash IS NOT NULL AND l.hash IS DISTINCT FROM h.head_hash) AS bad_head,
        l.hash IS DISTINCT FROM sha256(l.prev_hash || convert_to(jsonb_build_array(
          l.id, l.workspace_id, l.organization_id, (extract(epoch FROM l.at) * 1000000)::bigint, l.actor_kind,
          l.actor_ref, l.action, l.resource_kind, l.resource_id, l.request_id, encode(l.ip_hmac, 'hex'),
          l.metadata)::text, 'UTF8')) AS bad_hash
      FROM app.audit_logs AS l
      LEFT JOIN app.audit_heads AS h
        ON h.day = audit_chain_check.day AND h.workspace_id IS NOT DISTINCT FROM l.workspace_id
      WHERE l.at >= (audit_chain_check.day::timestamp AT TIME ZONE 'UTC')
        AND l.at < ((audit_chain_check.day + 1)::timestamp AT TIME ZONE 'UTC')
      WINDOW w AS (PARTITION BY l.workspace_id ORDER BY l.at, l.id))
    SELECT c.id, c.at, c.workspace_id FROM chain AS c
    WHERE c.bad_hash OR c.bad_head OR c.prev_hash IS DISTINCT FROM coalesce(c.before, decode(repeat('00', 32), 'hex'))
    ORDER BY c.at, c.id LIMIT 1;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.ensure_partitions(), app.purge_expired(text), app.worker_heartbeat(text, text),
  app.worker_status(), app.outbox_lag(), app.job_lag(), app.outbox_claim(integer),
  app.outbox_mark(uuid, text, integer), app.email_outbox_claim(integer),
  app.email_outbox_mark(uuid, integer, boolean), app.email_suppression_add(text, text), app.signup_open(),
  app.signup_gate(text), app.instance_settings_read(), app.audit_chain_check(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ensure_partitions(), app.purge_expired(text), app.worker_heartbeat(text, text),
  app.outbox_claim(integer), app.outbox_mark(uuid, text, integer), app.email_outbox_claim(integer),
  app.email_outbox_mark(uuid, integer, boolean) TO shoutory_worker;
GRANT EXECUTE ON FUNCTION app.worker_status(), app.outbox_lag(), app.job_lag(), app.instance_settings_read()
  TO shoutory_app;
GRANT EXECUTE ON FUNCTION app.email_suppression_add(text, text) TO shoutory_worker, shoutory_app;
GRANT EXECUTE ON FUNCTION app.signup_open() TO shoutory_auth, shoutory_app;
GRANT EXECUTE ON FUNCTION app.signup_gate(text) TO shoutory_auth;
ALTER FUNCTION app.ensure_partitions() OWNER TO shoutory_definer;
ALTER FUNCTION app.purge_expired(text) OWNER TO shoutory_definer;
ALTER FUNCTION app.worker_heartbeat(text, text) OWNER TO shoutory_definer;
ALTER FUNCTION app.worker_status() OWNER TO shoutory_definer;
ALTER FUNCTION app.outbox_lag() OWNER TO shoutory_definer;
ALTER FUNCTION app.job_lag() OWNER TO shoutory_definer;
ALTER FUNCTION app.outbox_claim(integer) OWNER TO shoutory_definer;
ALTER FUNCTION app.outbox_mark(uuid, text, integer) OWNER TO shoutory_definer;
ALTER FUNCTION app.email_outbox_claim(integer) OWNER TO shoutory_definer;
ALTER FUNCTION app.email_outbox_mark(uuid, integer, boolean) OWNER TO shoutory_definer;
ALTER FUNCTION app.email_suppression_add(text, text) OWNER TO shoutory_definer;
ALTER FUNCTION app.signup_open() OWNER TO shoutory_definer;
ALTER FUNCTION app.signup_gate(text) OWNER TO shoutory_definer;
ALTER FUNCTION app.instance_settings_read() OWNER TO shoutory_definer;
ALTER FUNCTION app.audit_chain_check(date) OWNER TO shoutory_definer;
-- A grant made before the owner changed does not survive it, so the verifier's one grant is made by its new owner.
SET ROLE shoutory_definer;
GRANT EXECUTE ON FUNCTION app.audit_chain_check(date) TO shoutory_owner;
RESET ROLE;

-- The partitioned parent belongs to the definer role (creating a leaf needs the parent's owner; audit_logs passed to
-- it in 0008); then the first leaves, run as that role exactly as the daily job will.
ALTER TABLE app.outbox OWNER TO shoutory_definer;
SET ROLE shoutory_definer;
SELECT app.ensure_partitions();
RESET ROLE;
