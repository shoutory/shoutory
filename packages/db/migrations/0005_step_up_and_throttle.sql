-- The first migration with SECURITY DEFINER functions. The definer role may own functions in schema app only if
-- it holds CREATE there: ALTER FUNCTION ... OWNER TO needs it, and the migration owner may switch to the role.
GRANT CREATE ON SCHEMA app TO shoutory_definer;

-- The templates U, I and D join W. The function stays a migration tool: only the owner may run it.
--
-- U: a user-owned row outside any workspace. A session of kind user reads the rows whose key column is its own
-- principal id. There is no write policy and no write grant: writes go through definer functions.
-- I and D: row security is enabled and forced and no policy names a runtime role, so a runtime role is refused by
-- its missing grant; only a definer function with its own purpose policy reaches the table.
CREATE OR REPLACE FUNCTION app.apply_rls_template(tbl regclass, template text, key_col text DEFAULT 'workspace_id')
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  read_set constant text := format('%I = ANY ((SELECT app.ws_ids())::uuid[])', key_col);
  write_set constant text := format('%I = (SELECT app.write_ws()) AND ', key_col) || read_set;
BEGIN
  IF template IS NULL OR template NOT IN ('W', 'U', 'I', 'D') THEN
    RAISE EXCEPTION 'unknown template %', template USING ERRCODE = '22023';
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  IF template = 'U' THEN
    EXECUTE format(
      'CREATE POLICY u_select ON %s FOR SELECT TO shoutory_app, shoutory_worker '
      || 'USING (%I = (SELECT app.principal_id()) AND (SELECT app.principal_kind()) = ''user'')',
      tbl, key_col);
  ELSIF template = 'W' THEN
    EXECUTE format('CREATE POLICY w_select ON %s FOR SELECT TO shoutory_app, shoutory_worker USING (%s)', tbl, read_set);
    EXECUTE format('CREATE POLICY w_insert ON %s FOR INSERT TO shoutory_app, shoutory_worker WITH CHECK (%s)', tbl, write_set);
    EXECUTE format(
      'CREATE POLICY w_update ON %s FOR UPDATE TO shoutory_app, shoutory_worker USING (%s) WITH CHECK (%s)',
      tbl, write_set, write_set);
    EXECUTE format('CREATE POLICY w_delete ON %s FOR DELETE TO shoutory_app, shoutory_worker USING (%s)', tbl, write_set);
    EXECUTE format(
      'CREATE POLICY portal_restrictive ON %s AS RESTRICTIVE FOR ALL TO shoutory_app, shoutory_worker '
      || 'USING ((SELECT app.principal_kind()) <> ''portal'')',
      tbl);
  END IF;
END
$$;

REVOKE ALL ON FUNCTION app.apply_rls_template(regclass, text, text) FROM PUBLIC;

-- The throttle. One row per scope and key: the same digest under two scopes (one address serves login_ip and
-- link_confirm) is two buckets. Capacity and refill are constants of bucket_limits, never stored or passed in.
-- Scopes of later slices are in the CHECK already and have no numbers, so the definers refuse them until they do.
CREATE TABLE app.rate_buckets (
  scope text NOT NULL CHECK (scope IN (
    'login_account', 'login_ip', 'verification_resend', 'invite', 'invite_accept', 'unsubscribe',
    'two_factor', 'password_reset', 'totp_code', 'link_confirm')),
  key text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  tokens double precision NOT NULL,
  refilled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, key)
);
SELECT app.apply_rls_template('app.rate_buckets'::regclass, 'D');
GRANT SELECT, INSERT, UPDATE ON app.rate_buckets TO shoutory_definer;
CREATE POLICY bucket_take_all ON app.rate_buckets FOR ALL TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'bucket_take') WITH CHECK ((SELECT app.job_purpose()) = 'bucket_take');
CREATE POLICY bucket_state_select ON app.rate_buckets FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'bucket_state');

-- Capacity in tokens and the seconds a full refill takes. Called only by the two definers below.
CREATE FUNCTION app.bucket_limits(scope text)
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
    ('link_confirm', 20, 900)
  ) AS l (name, capacity, refill_seconds) WHERE l.name = scope
$$;
REVOKE ALL ON FUNCTION app.bucket_limits(text) FROM PUBLIC;
ALTER FUNCTION app.bucket_limits(text) OWNER TO shoutory_definer;

-- Spends one token (cost 1) or refunds up to the capacity (cost -capacity..-1). The row is created full on first
-- use, then locked, refilled for the time that passed and updated, so two callers never spend the same token.
-- A refund on a key with no bucket writes nothing: a missing bucket is already full.
CREATE FUNCTION app.bucket_take(key text, scope text, cost integer DEFAULT 1)
RETURNS TABLE (allowed boolean, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  cap integer;
  span integer;
  have double precision;
  found_row boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'bucket_take', true);
  SELECT l.capacity, l.refill_seconds INTO cap, span FROM app.bucket_limits(bucket_take.scope) AS l;
  IF cap IS NULL OR bucket_take.key !~ '^[0-9a-f]{64}$'
     OR NOT (bucket_take.cost = 1 OR bucket_take.cost BETWEEN -cap AND -1) THEN
    RAISE EXCEPTION 'bucket_take refuses this scope, key or cost' USING ERRCODE = '22023';
  END IF;
  IF bucket_take.cost = 1 THEN
    INSERT INTO app.rate_buckets (scope, key, tokens) VALUES (bucket_take.scope, bucket_take.key, cap)
      ON CONFLICT ON CONSTRAINT rate_buckets_pkey DO NOTHING;
  END IF;
  SELECT least(cap, b.tokens + greatest(0, extract(epoch FROM clock_timestamp() - b.refilled_at)) * cap / span), true
    INTO have, found_row
    FROM app.rate_buckets AS b
    WHERE b.scope = bucket_take.scope AND b.key = bucket_take.key
    FOR UPDATE;
  IF NOT coalesce(found_row, false) THEN
    allowed := true; remaining := cap; retry_after_seconds := 0;
  ELSE
    allowed := have >= 1 OR bucket_take.cost < 0;
    IF allowed THEN have := least(cap, have - bucket_take.cost); END IF;
    UPDATE app.rate_buckets AS b SET tokens = have, refilled_at = clock_timestamp()
      WHERE b.scope = bucket_take.scope AND b.key = bucket_take.key;
    remaining := floor(have)::integer;
    retry_after_seconds := CASE WHEN allowed THEN 0 ELSE ceil((1 - have) * span / cap)::integer END;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEXT;
END
$$;

-- The same answer as bucket_take for a cost of one, without spending or writing anything.
CREATE FUNCTION app.bucket_state(key text, scope text)
RETURNS TABLE (allowed boolean, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  cap integer;
  span integer;
  have double precision;
BEGIN
  PERFORM set_config('app.job_purpose', 'bucket_state', true);
  SELECT l.capacity, l.refill_seconds INTO cap, span FROM app.bucket_limits(bucket_state.scope) AS l;
  IF cap IS NULL OR bucket_state.key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'bucket_state refuses this scope or key' USING ERRCODE = '22023';
  END IF;
  SELECT least(cap, b.tokens + greatest(0, extract(epoch FROM clock_timestamp() - b.refilled_at)) * cap / span)
    INTO have
    FROM app.rate_buckets AS b WHERE b.scope = bucket_state.scope AND b.key = bucket_state.key;
  have := coalesce(have, cap);
  allowed := have >= 1;
  remaining := floor(have)::integer;
  retry_after_seconds := CASE WHEN allowed THEN 0 ELSE ceil((1 - have) * span / cap)::integer END;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION app.bucket_take(text, text, integer), app.bucket_state(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bucket_take(text, text, integer), app.bucket_state(text, text)
  TO shoutory_auth, shoutory_app, shoutory_worker;
ALTER FUNCTION app.bucket_take(text, text, integer) OWNER TO shoutory_definer;
ALTER FUNCTION app.bucket_state(text, text) OWNER TO shoutory_definer;

-- A recent proof of identity, per session. The user reads their own rows (template U); only the definers write
-- and read them for the auth and app roles. session_id is a plain uuid: its retention class removes old rows.
CREATE TABLE app.session_step_ups (
  session_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('password', 'totp')),
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX session_step_ups_session_idx ON app.session_step_ups (session_id, at DESC);
-- The template U predicate and the delete cascade from auth."user" both look rows up by user_id.
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX session_step_ups_user_idx ON app.session_step_ups (user_id);
SELECT app.apply_rls_template('app.session_step_ups'::regclass, 'U', 'user_id');
GRANT SELECT, INSERT ON app.session_step_ups TO shoutory_definer;
GRANT SELECT ON app.session_step_ups TO shoutory_app, shoutory_worker;
CREATE POLICY step_up_record_insert ON app.session_step_ups FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'step_up_record');
CREATE POLICY step_up_read_select ON app.session_step_ups FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'step_up_read');

CREATE FUNCTION app.step_up_record(session_id uuid, user_id uuid, method text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'step_up_record', true);
  INSERT INTO app.session_step_ups (session_id, user_id, method)
    VALUES (step_up_record.session_id, step_up_record.user_id, step_up_record.method);
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The newest record of the one session of the one user, and nothing once it is 10 minutes old. Callers hold both
-- ids from the authenticated session; a session id alone never reads another user's record.
CREATE FUNCTION app.step_up_read(session_id uuid, user_id uuid)
RETURNS TABLE (method text, at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'step_up_read', true);
  RETURN QUERY
    SELECT s.method, s.at FROM app.session_step_ups AS s
    WHERE s.session_id = step_up_read.session_id AND s.user_id = step_up_read.user_id AND s.at > clock_timestamp() - interval '10 minutes'
    ORDER BY s.at DESC LIMIT 1;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.step_up_record(uuid, uuid, text), app.step_up_read(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.step_up_record(uuid, uuid, text) TO shoutory_auth;
GRANT EXECUTE ON FUNCTION app.step_up_read(uuid, uuid) TO shoutory_auth, shoutory_app;
ALTER FUNCTION app.step_up_record(uuid, uuid, text) OWNER TO shoutory_definer;
ALTER FUNCTION app.step_up_read(uuid, uuid) OWNER TO shoutory_definer;

-- The profile of a user. last_workspace_id is a plain uuid until the workspaces table exists (0007 adds its key);
-- password_recheck_at is set only through password_recheck_set. Locale and the like come with their consumer.
CREATE TABLE app.user_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth."user" (id) ON DELETE CASCADE,
  last_workspace_id uuid,
  password_recheck_at timestamptz
);
SELECT app.apply_rls_template('app.user_profiles'::regclass, 'U', 'user_id');
GRANT SELECT, INSERT, UPDATE ON app.user_profiles TO shoutory_definer;
GRANT SELECT ON app.user_profiles TO shoutory_app, shoutory_worker;
CREATE POLICY password_recheck_set_all ON app.user_profiles FOR ALL TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'password_recheck_set')
  WITH CHECK ((SELECT app.job_purpose()) = 'password_recheck_set');

-- Creates the profile row when none exists. A NULL due clears the re-check.
CREATE FUNCTION app.password_recheck_set(user_id uuid, due timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'password_recheck_set', true);
  INSERT INTO app.user_profiles (user_id, password_recheck_at)
    VALUES (password_recheck_set.user_id, password_recheck_set.due)
    ON CONFLICT ON CONSTRAINT user_profiles_pkey DO UPDATE SET password_recheck_at = EXCLUDED.password_recheck_at;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.password_recheck_set(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.password_recheck_set(uuid, timestamptz) TO shoutory_auth;
ALTER FUNCTION app.password_recheck_set(uuid, timestamptz) OWNER TO shoutory_definer;

-- The instance admins. granted_by is NULL for the founder and is a plain uuid on purpose: a foreign key that sets
-- it to NULL would mint a second founder. The partial unique index allows one founder row and is the race guard of
-- instance_admin_claim.
CREATE TABLE app.instance_admins (
  user_id uuid PRIMARY KEY REFERENCES auth."user" (id) ON DELETE CASCADE,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now()
);
-- shoutory:accepted-lock new empty table in this file
CREATE UNIQUE INDEX instance_admins_founder_idx ON app.instance_admins ((true)) WHERE granted_by IS NULL;
SELECT app.apply_rls_template('app.instance_admins'::regclass, 'I');
GRANT SELECT, INSERT ON app.instance_admins TO shoutory_definer;
GRANT SELECT (id, email_verified) ON auth."user" TO shoutory_definer;
CREATE POLICY instance_admin_claim_select ON app.instance_admins FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'instance_admin_claim');
CREATE POLICY instance_admin_claim_insert ON app.instance_admins FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'instance_admin_claim');

-- The first verified user becomes the instance owner, once. The row is inserted only while the table is empty; two
-- calls at the same time meet at the founder index, and the loser inserts nothing. A deleted founder does not
-- reopen the claim while any admin row exists.
CREATE FUNCTION app.instance_admin_claim(user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  inserted bigint;
BEGIN
  PERFORM set_config('app.job_purpose', 'instance_admin_claim', true);
  INSERT INTO app.instance_admins (user_id)
    SELECT u.id FROM auth."user" AS u
    WHERE u.id = instance_admin_claim.user_id AND u.email_verified
      AND NOT EXISTS (SELECT 1 FROM app.instance_admins AS a)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN inserted = 1;
END
$$;

REVOKE ALL ON FUNCTION app.instance_admin_claim(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instance_admin_claim(uuid) TO shoutory_auth;
ALTER FUNCTION app.instance_admin_claim(uuid) OWNER TO shoutory_definer;
