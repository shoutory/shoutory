-- The connect schema: the OAuth sign-in state of a channel connect, the Telegram connect word, the definers that write and
-- consume them, and the step-up method a backup code needs. Neither table has a runtime grant: the state and the word are
-- single use, so every write and every take is a definer with its own purpose policy (as 0010 and 0014 do).

-- One row per started OAuth connect. The state is the proof that a callback belongs to the person, workspace, provider and
-- instance host that started it: only its digest is stored, and the verifier (and the DPoP key, when the provider binds
-- one) is one sealed object in the eight sealed columns of 0014, AAD scope `workspace_id` and owner this row's id. The
-- state is unique per workspace like an invitation's digest (the callback carries no workspace, so it is also looked up
-- by the digest alone and a match in two workspaces is refused).
CREATE TABLE app.oauth_flows (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  channel_id uuid,
  instance_host text CHECK (char_length(instance_host) BETWEEN 1 AND 253),
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 64),
  state_hash bytea NOT NULL CHECK (octet_length(state_hash) = 32),
  format_version integer NOT NULL,
  key_id text NOT NULL CHECK (key_id ~ '^[a-z0-9-]{1,32}$'),
  iv bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  wrap_iv bytea NOT NULL,
  wrap_tag bytea NOT NULL,
  wrapped_dek bytea NOT NULL,
  request_uri text CHECK (char_length(request_uri) <= 2048),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT oauth_flows_workspace_state_key UNIQUE (workspace_id, state_hash),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES app.channels (workspace_id, id) ON DELETE CASCADE
);
-- The callback finds its flow by the digest alone.
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX oauth_flows_state_hash_idx ON app.oauth_flows (state_hash);
-- The cascades from a user and from a channel look their rows up by these columns.
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX oauth_flows_user_idx ON app.oauth_flows (user_id);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX oauth_flows_channel_idx ON app.oauth_flows (workspace_id, channel_id);
SELECT app.apply_rls_template('app.oauth_flows'::regclass, 'D');

-- Template D (as 0014's sealed tables): no runtime role holds a grant or a policy; only a definer under its purpose.
GRANT SELECT, INSERT, DELETE ON app.oauth_flows TO shoutory_definer;
GRANT UPDATE (consumed_at) ON app.oauth_flows TO shoutory_definer;
CALL app.grant_purposes('oauth_flows', 'SELECT', ARRAY['oauth_flow_take', 'purge_expired']);
CALL app.grant_purposes('oauth_flows', 'INSERT', ARRAY['oauth_flow_put']);
CALL app.grant_purposes('oauth_flows', 'UPDATE', ARRAY['oauth_flow_take']);
CALL app.grant_purposes('oauth_flows', 'DELETE', ARRAY['purge_expired']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['oauth_flow_put']);
DO $$
DECLARE
  t text;
BEGIN
  -- The principal check reads the tables of the tenancy rank, and the audit row reads the workspace's organization.
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['oauth_flow_put', 'oauth_flow_take']);
  END LOOP;
END
$$;

-- An old flow is removed a day after it expires (data-model retention, the 0012 registry). The registry has no runtime
-- policy and forces row security on its owner too, so the row goes in under a policy that exists only for this statement.
CREATE POLICY retention_seed_insert ON app.retention_classes FOR INSERT TO shoutory_owner WITH CHECK (true);
INSERT INTO app.retention_classes (class, table_name, kind, event_column, retain, partition_unit) VALUES
  ('app.oauth_flows', 'app.oauth_flows', 'window', 'expires_at', interval '1 day', NULL);
DROP POLICY retention_seed_insert ON app.retention_classes;

SET ROLE shoutory_definer;

-- Writes one flow for the signed-in user: an Admin or above of the workspace, never a job or another kind of principal.
-- The user comes from the session, the expiry (10 minutes) from the database clock, and a channel (a reconnect) must
-- belong to the workspace. The sealed object is the application's to seal; the state digest is of a random state.
CREATE FUNCTION app.oauth_flow_put(
  workspace_id uuid, provider_id text, state_hash bytea, channel_id uuid, instance_host text, format_version integer,
  key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea,
  request_uri text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  new_id constant uuid := uuidv7();
BEGIN
  PERFORM set_config('app.job_purpose', 'oauth_flow_put', true);
  IF app.principal_kind() IS DISTINCT FROM 'user' OR caller IS NULL
     OR app.tenancy_rank(oauth_flow_put.workspace_id, caller) < 4 THEN
    RAISE EXCEPTION 'oauth_flow_put: refused' USING ERRCODE = '42501';
  END IF;
  IF oauth_flow_put.channel_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.channels AS c
       WHERE c.workspace_id = oauth_flow_put.workspace_id AND c.id = oauth_flow_put.channel_id) THEN
    RAISE EXCEPTION 'oauth_flow_put: refused' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.oauth_flows (id, workspace_id, user_id, channel_id, instance_host, provider_id, state_hash,
      format_version, key_id, iv, ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, request_uri, expires_at)
    VALUES (new_id, oauth_flow_put.workspace_id, caller, oauth_flow_put.channel_id, oauth_flow_put.instance_host,
      oauth_flow_put.provider_id, oauth_flow_put.state_hash, oauth_flow_put.format_version, oauth_flow_put.key_id,
      oauth_flow_put.iv, oauth_flow_put.ciphertext, oauth_flow_put.auth_tag, oauth_flow_put.wrap_iv,
      oauth_flow_put.wrap_tag, oauth_flow_put.wrapped_dek, oauth_flow_put.request_uri,
      clock_timestamp() + interval '10 minutes');
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;

-- The callback's one step: every unspent flow with this state digest is spent by a single UPDATE (a second concurrent
-- taker re-reads the WHERE after the first commits and finds nothing, PostgreSQL 18 transaction isolation, Read
-- Committed), then the one it spent is judged. A refusal is an answer, never an error, so the spent state and its audit
-- row survive: unknown_state (nothing is spent), consumed, expired, wrong_provider, wrong_instance_host, wrong_user,
-- not_admin (the caller is no longer Admin or above of the flow's workspace) and ambiguous (the digest names flows in
-- more than one workspace: all are spent, none is returned). Only `ok` returns the flow and its sealed object. A refusal
-- is audited as channel.connect_refused with its kind; an ok take writes none (the connect itself is audited later).
CREATE FUNCTION app.oauth_flow_take(
  state_digest bytea, want_provider text, want_host text, request_id text, ip_hmac bytea)
RETURNS TABLE (
  outcome text, flow_id uuid, workspace_id uuid, user_id uuid, channel_id uuid, instance_host text, request_uri text,
  format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea,
  wrapped_dek bytea)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  hit record;
  seen record;
  kind text;
  audit_ws uuid;
  audit_flow uuid;
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'user' OR caller IS NULL THEN
    RAISE EXCEPTION 'oauth_flow_take: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.job_purpose', 'oauth_flow_take', true);
  WITH spent AS (
    UPDATE app.oauth_flows AS f SET consumed_at = clock_timestamp()
      WHERE f.state_hash = oauth_flow_take.state_digest AND f.consumed_at IS NULL RETURNING f.*),
  counted AS (SELECT count(*)::integer AS n FROM spent)
  SELECT counted.n, s.* INTO hit FROM counted LEFT JOIN spent AS s ON true LIMIT 1;
  IF hit.n = 0 THEN
    SELECT count(*)::integer AS n, (array_agg(f.workspace_id))[1] AS ws, (array_agg(f.id))[1] AS flow INTO seen
      FROM app.oauth_flows AS f WHERE f.state_hash = oauth_flow_take.state_digest;
    kind := CASE WHEN seen.n = 0 THEN 'unknown_state' ELSE 'consumed' END;
    IF seen.n = 1 THEN audit_ws := seen.ws; audit_flow := seen.flow; END IF;
  ELSIF hit.n > 1 THEN
    kind := 'ambiguous';
  ELSE
    audit_ws := hit.workspace_id;
    audit_flow := hit.id;
    kind := CASE
      WHEN hit.expires_at <= clock_timestamp() THEN 'expired'
      WHEN hit.provider_id <> oauth_flow_take.want_provider THEN 'wrong_provider'
      WHEN hit.instance_host IS DISTINCT FROM oauth_flow_take.want_host THEN 'wrong_instance_host'
      WHEN hit.user_id <> caller THEN 'wrong_user'
      WHEN app.tenancy_rank(hit.workspace_id, caller) < 4 THEN 'not_admin'
      ELSE 'ok' END;
  END IF;
  IF kind = 'ok' THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN QUERY SELECT kind, hit.id, hit.workspace_id, hit.user_id, hit.channel_id, hit.instance_host,
      hit.request_uri, hit.format_version, hit.key_id, hit.iv, hit.ciphertext, hit.auth_tag, hit.wrap_iv, hit.wrap_tag,
      hit.wrapped_dek;
    RETURN;
  END IF;
  PERFORM app.audit_append(audit_ws, (SELECT w.organization_id FROM app.workspaces AS w WHERE w.id = audit_ws), 'user',
    caller::text, 'channel.connect_refused', 'oauth_flow', coalesce(audit_flow::text, 'unknown'),
    oauth_flow_take.request_id, oauth_flow_take.ip_hmac, jsonb_build_object('outcome', kind));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN QUERY SELECT kind, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::integer,
    NULL::text, NULL::bytea, NULL::bytea, NULL::bytea, NULL::bytea, NULL::bytea, NULL::bytea;
END
$$;

REVOKE ALL ON FUNCTION app.oauth_flow_put(uuid, text, bytea, uuid, text, integer, text, bytea, bytea, bytea, bytea,
  bytea, bytea, text), app.oauth_flow_take(bytea, text, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.oauth_flow_put(uuid, text, bytea, uuid, text, integer, text, bytea, bytea, bytea, bytea,
  bytea, bytea, text), app.oauth_flow_take(bytea, text, text, text, bytea) TO shoutory_app;
RESET ROLE;

-- One row per Telegram connect word: `/connect <word>` sent to the bot proves the sender controls the chat. Only the
-- digest of the word is stored, it is unique per workspace and provider while unspent, and it lives 10 minutes from its
-- creation (the definer that creates a word sets `expires_at`). Template D like the flows: no runtime role holds a grant.
CREATE TABLE app.connect_challenges (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 64),
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
-- shoutory:accepted-lock new empty table in this file
CREATE UNIQUE INDEX connect_challenges_unspent_key ON app.connect_challenges (workspace_id, provider_id, code_hash)
  WHERE consumed_at IS NULL;
SELECT app.apply_rls_template('app.connect_challenges'::regclass, 'D');

GRANT SELECT, DELETE ON app.connect_challenges TO shoutory_definer;
GRANT UPDATE (consumed_at) ON app.connect_challenges TO shoutory_definer;
CALL app.grant_purposes('connect_challenges', 'SELECT', ARRAY['connect_challenge_take', 'purge_expired']);
CALL app.grant_purposes('connect_challenges', 'UPDATE', ARRAY['connect_challenge_take']);
CALL app.grant_purposes('connect_challenges', 'DELETE', ARRAY['purge_expired']);
DO $$
DECLARE
  t text;
BEGIN
  -- The principal check (credential_caller) reads the tables of the tenancy rank.
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['connect_challenge_take']);
  END LOOP;
END
$$;

CREATE POLICY retention_seed_insert ON app.retention_classes FOR INSERT TO shoutory_owner WITH CHECK (true);
INSERT INTO app.retention_classes (class, table_name, kind, event_column, retain, partition_unit) VALUES
  ('app.connect_challenges', 'app.connect_challenges', 'window', 'expires_at', interval '1 day', NULL);
DROP POLICY retention_seed_insert ON app.retention_classes;

SET ROLE shoutory_definer;

-- Spends the word of one workspace and provider and answers its id, or NULL when no unspent, unexpired word matches (a
-- wrong workspace, provider or word, a word already taken, one past its 10 minutes): one UPDATE, so of two concurrent
-- takers one gets the id (PostgreSQL 18 transaction isolation, Read Committed re-reads the WHERE). The caller is a job
-- principal of the workspace (the poller) or a user Admin of it, as for every credential definer.
CREATE FUNCTION app.connect_challenge_take(workspace_id uuid, provider_id text, code_hash bytea)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  taken uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'connect_challenge_take', true);
  PERFORM app.credential_caller(connect_challenge_take.workspace_id);
  UPDATE app.connect_challenges AS c SET consumed_at = clock_timestamp()
    WHERE c.workspace_id = connect_challenge_take.workspace_id AND c.provider_id = connect_challenge_take.provider_id
      AND c.code_hash = connect_challenge_take.code_hash AND c.consumed_at IS NULL AND c.expires_at > clock_timestamp()
    RETURNING c.id INTO taken;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN taken;
END
$$;

REVOKE ALL ON FUNCTION app.connect_challenge_take(uuid, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.connect_challenge_take(uuid, text, bytea) TO shoutory_app, shoutory_worker;
RESET ROLE;

-- A backup-code sign-in counts as a recent step-up as a TOTP sign-in does (R545): the method CHECK of 0005 (named for its
-- column) is the only gate, since step_up_record stores the value it is given. The constraint is replaced the way 0013 does
-- it (NOT VALID, then VALIDATE in the same file) on the table that keeps its rows one day.
-- shoutory:accepted-lock the step-up table is small and its rows expire within a day; the lock is held for this migration only
ALTER TABLE app.session_step_ups DROP CONSTRAINT session_step_ups_method_check;
-- shoutory:accepted-lock same small table, same transaction
ALTER TABLE app.session_step_ups ADD CONSTRAINT session_step_ups_method_check
  CHECK (method IN ('password', 'totp', 'backup_code')) NOT VALID;
-- shoutory:accepted-lock the ACCESS EXCLUSIVE lock of the ADD above is still held while VALIDATE scans, harmless on a table that keeps rows one day
ALTER TABLE app.session_step_ups VALIDATE CONSTRAINT session_step_ups_method_check;
