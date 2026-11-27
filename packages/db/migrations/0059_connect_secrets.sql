-- A connect challenge holds the bot token a person pasted until a chat proves they control it, so it carries the sealed
-- token, the digest of the bot and the chat that answered with the word.
ALTER TABLE app.connect_challenges
  ADD COLUMN channel_id uuid,
  ADD COLUMN format_version integer,
  ADD COLUMN key_id text,
  ADD COLUMN iv bytea,
  ADD COLUMN ciphertext bytea,
  ADD COLUMN auth_tag bytea,
  ADD COLUMN wrap_iv bytea,
  ADD COLUMN wrap_tag bytea,
  ADD COLUMN wrapped_dek bytea,
  ADD COLUMN bot_digest bytea,
  ADD COLUMN matched_chat_id text,
  ADD COLUMN matched_title text;
-- shoutory:accepted-lock adding a check scans the table under an exclusive lock; it holds only challenges younger than a day
ALTER TABLE app.connect_challenges
  ADD CONSTRAINT connect_challenges_key_id_check CHECK (key_id ~ '^[a-z0-9-]{1,32}$'),
  ADD CONSTRAINT connect_challenges_bot_digest_check CHECK (octet_length(bot_digest) = 32),
  ADD CONSTRAINT connect_challenges_matched_chat_check CHECK (char_length(matched_chat_id) BETWEEN 1 AND 64),
  ADD CONSTRAINT connect_challenges_matched_title_check CHECK (char_length(matched_title) <= 256);
-- shoutory:accepted-lock same small table
CREATE UNIQUE INDEX connect_challenges_bot_open_key ON app.connect_challenges (bot_digest)
  WHERE consumed_at IS NULL AND bot_digest IS NOT NULL;

-- The digest of the bot a channel was made with, so a claim lives exactly as long as a channel or a challenge uses it.
ALTER TABLE app.channel_credentials ADD COLUMN bot_digest bytea;
-- shoutory:accepted-lock adding a check scans the table under an exclusive lock; it holds one row per channel, so the scan is short
ALTER TABLE app.channel_credentials
  ADD CONSTRAINT channel_credentials_bot_digest_check CHECK (octet_length(bot_digest) = 32);
-- shoutory:accepted-lock the index is partial and no row carries a digest yet, so it builds empty over a short scan
CREATE INDEX channel_credentials_bot_digest_idx ON app.channel_credentials (bot_digest)
  WHERE bot_digest IS NOT NULL;

-- One row per bot. The offset into the bot's updates belongs to the bot, not to a challenge, because the bot has one
-- queue however many challenges read it.
CREATE TABLE app.bot_claims (
  bot_digest bytea PRIMARY KEY CHECK (octet_length(bot_digest) = 32),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  update_offset bigint NOT NULL DEFAULT 0 CHECK (update_offset >= 0)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX bot_claims_workspace_idx ON app.bot_claims (workspace_id);
SELECT app.apply_rls_template('app.bot_claims'::regclass, 'D');

GRANT SELECT, INSERT, DELETE ON app.bot_claims TO shoutory_definer;
GRANT UPDATE (workspace_id, update_offset) ON app.bot_claims TO shoutory_definer;
GRANT INSERT ON app.connect_challenges TO shoutory_definer;
GRANT UPDATE (code_hash, expires_at, format_version, key_id, iv, ciphertext, auth_tag, wrap_iv, wrap_tag,
  wrapped_dek, matched_chat_id, matched_title) ON app.connect_challenges TO shoutory_definer;

CALL app.grant_purposes('bot_claims', 'SELECT', ARRAY['bot_claim', 'bot_claim_release', 'connect_challenge_open_due',
  'connect_challenge_match']);
CALL app.grant_purposes('bot_claims', 'INSERT', ARRAY['bot_claim']);
CALL app.grant_purposes('bot_claims', 'UPDATE', ARRAY['bot_claim', 'connect_challenge_match']);
CALL app.grant_purposes('bot_claims', 'DELETE', ARRAY['bot_claim_release']);
CALL app.grant_purposes('connect_challenges', 'SELECT', ARRAY['bot_claim', 'bot_claim_release',
  'connect_challenge_put', 'connect_challenge_renew', 'connect_challenge_open_due', 'connect_challenge_match',
  'connect_challenge_status', 'channel_connect', 'credential_put', 'sealed_key_ids']);
CALL app.grant_purposes('connect_challenges', 'INSERT', ARRAY['connect_challenge_put']);
CALL app.grant_purposes('connect_challenges', 'UPDATE', ARRAY['connect_challenge_put', 'connect_challenge_renew',
  'connect_challenge_match', 'credential_put']);
CALL app.grant_purposes('channel_credentials', 'SELECT', ARRAY['bot_claim', 'bot_claim_release']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['connect_challenge_put']);
CALL app.grant_purposes('workspace_key_salts', 'SELECT', ARRAY['connect_challenge_open_due']);
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['connect_challenge_put', 'connect_challenge_renew',
      'connect_challenge_status']);
  END LOOP;
END
$$;

CALL app.grant_purposes('connect_challenges', 'UPDATE', ARRAY['connect_challenge_open_due']);
DROP FUNCTION app.connect_challenge_take(uuid, text, bytea);
DROP FUNCTION app.channel_connect(uuid, text, text, text, text, text, text, text, uuid, text, bytea);
DROP FUNCTION app.credential_put(uuid, uuid, integer, integer, text, bytea, bytea, bytea, bytea, bytea, bytea,
  timestamptz, timestamptz, text, text, text, timestamptz, jsonb, jsonb, text, bytea);
DROP FUNCTION app.credential_open(uuid, uuid);

SET ROLE shoutory_definer;

-- A claim is in use while a channel was made with the bot, while an unspent challenge holds its token, or for ten
-- minutes after a challenge was taken and before the channel exists.
CREATE FUNCTION app.bot_claim_live(p_bot_digest bytea)
RETURNS boolean
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app.channel_credentials AS k WHERE k.bot_digest = p_bot_digest)
    OR EXISTS (
      SELECT 1 FROM app.connect_challenges AS c
      WHERE c.bot_digest = p_bot_digest AND c.ciphertext IS NOT NULL
        AND ((c.consumed_at IS NULL AND c.expires_at > clock_timestamp())
          OR c.consumed_at > clock_timestamp() - interval '10 minutes'))
$$;

-- True when the workspace holds the claim after the call. A claim nobody uses any more passes to the caller with a
-- fresh offset; one in use by another workspace is refused.
CREATE FUNCTION app.bot_claim(p_bot_digest bytea, p_workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  held uuid;
  mine boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'bot_claim', true);
  -- A release may delete the row between the insert and the read, so a missing row is a reason to try again.
  LOOP
    INSERT INTO app.bot_claims (bot_digest, workspace_id) VALUES (p_bot_digest, p_workspace_id)
      ON CONFLICT (bot_digest) DO NOTHING;
    SELECT b.workspace_id INTO held FROM app.bot_claims AS b WHERE b.bot_digest = p_bot_digest FOR UPDATE;
    EXIT WHEN FOUND;
  END LOOP;
  IF held = p_workspace_id THEN
    mine := true;
  ELSIF NOT app.bot_claim_live(p_bot_digest) THEN
    UPDATE app.bot_claims AS b SET workspace_id = p_workspace_id, update_offset = 0
      WHERE b.bot_digest = p_bot_digest;
    mine := true;
  ELSE
    mine := false;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN mine;
END
$$;

-- Fires when a credential row goes, including with its channel or workspace: the claim ends with its last user.
CREATE FUNCTION app.bot_claim_release()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF OLD.bot_digest IS NOT NULL THEN
    PERFORM set_config('app.job_purpose', 'bot_claim_release', true);
    DELETE FROM app.bot_claims AS b
      WHERE b.bot_digest = OLD.bot_digest AND NOT app.bot_claim_live(OLD.bot_digest);
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  END IF;
  RETURN OLD;
END
$$;

-- Only an Admin or above of the workspace. The user comes from the session and the expiry from the database clock; the
-- id is the one the token was sealed under. A bot another workspace uses is refused with the generic answer, and a new
-- challenge ends the bot's older ones.
CREATE FUNCTION app.connect_challenge_put(
  challenge_id uuid, workspace_id uuid, provider_id text, code_hash bytea, bot_digest bytea, channel_id uuid,
  format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea,
  wrapped_dek bytea)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
BEGIN
  PERFORM set_config('app.job_purpose', 'connect_challenge_put', true);
  IF app.principal_kind() IS DISTINCT FROM 'user' OR caller IS NULL
     OR app.tenancy_rank(connect_challenge_put.workspace_id, caller) < 4 THEN
    RAISE EXCEPTION 'connect_challenge_put: refused' USING ERRCODE = '42501';
  END IF;
  IF connect_challenge_put.channel_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.channels AS c
       WHERE c.workspace_id = connect_challenge_put.workspace_id AND c.id = connect_challenge_put.channel_id
         AND c.provider_id = connect_challenge_put.provider_id) THEN
    RAISE EXCEPTION 'connect_challenge_put: refused' USING ERRCODE = '42501';
  END IF;
  IF NOT app.bot_claim(connect_challenge_put.bot_digest, connect_challenge_put.workspace_id) THEN
    RAISE EXCEPTION 'connect_challenge_put: refused' USING ERRCODE = 'SH409';
  END IF;
  -- A replaced challenge ends without a channel, and forgets its chat so it never reads as one that connected.
  UPDATE app.connect_challenges AS c SET consumed_at = clock_timestamp(), matched_chat_id = NULL,
      matched_title = NULL, format_version = NULL, key_id = NULL, iv = NULL, ciphertext = NULL, auth_tag = NULL,
      wrap_iv = NULL, wrap_tag = NULL, wrapped_dek = NULL
    WHERE c.bot_digest = connect_challenge_put.bot_digest AND c.consumed_at IS NULL;
  INSERT INTO app.connect_challenges (id, workspace_id, provider_id, code_hash, channel_id, bot_digest,
      format_version, key_id, iv, ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, expires_at)
    VALUES (connect_challenge_put.challenge_id, connect_challenge_put.workspace_id, connect_challenge_put.provider_id,
      connect_challenge_put.code_hash, connect_challenge_put.channel_id, connect_challenge_put.bot_digest,
      connect_challenge_put.format_version, connect_challenge_put.key_id, connect_challenge_put.iv,
      connect_challenge_put.ciphertext, connect_challenge_put.auth_tag, connect_challenge_put.wrap_iv,
      connect_challenge_put.wrap_tag, connect_challenge_put.wrapped_dek, clock_timestamp() + interval '10 minutes');
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN connect_challenge_put.challenge_id;
END
$$;

-- A new word and a new ten minutes on the same row, keeping the sealed token, for a challenge no chat has answered. The
-- old word stops matching. NULL when the row is not such a challenge of the workspace and provider.
CREATE FUNCTION app.connect_challenge_renew(workspace_id uuid, provider_id text, challenge_id uuid, code_hash bytea)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  digest bytea;
  renewed timestamptz;
BEGIN
  PERFORM set_config('app.job_purpose', 'connect_challenge_renew', true);
  IF app.principal_kind() IS DISTINCT FROM 'user' OR caller IS NULL
     OR app.tenancy_rank(connect_challenge_renew.workspace_id, caller) < 4 THEN
    RAISE EXCEPTION 'connect_challenge_renew: refused' USING ERRCODE = '42501';
  END IF;
  SELECT c.bot_digest INTO digest FROM app.connect_challenges AS c
    WHERE c.id = connect_challenge_renew.challenge_id AND c.workspace_id = connect_challenge_renew.workspace_id
      AND c.provider_id = connect_challenge_renew.provider_id AND c.consumed_at IS NULL
      AND c.matched_chat_id IS NULL AND c.ciphertext IS NOT NULL;
  IF NOT FOUND THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN NULL;
  END IF;
  -- The bot is claimed before the challenge row is locked, as the put and the match do.
  IF NOT app.bot_claim(digest, connect_challenge_renew.workspace_id) THEN
    RAISE EXCEPTION 'connect_challenge_renew: refused' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.connect_challenges AS c SET code_hash = connect_challenge_renew.code_hash,
      expires_at = clock_timestamp() + interval '10 minutes'
    WHERE c.id = connect_challenge_renew.challenge_id AND c.consumed_at IS NULL AND c.matched_chat_id IS NULL
      AND c.ciphertext IS NOT NULL
    RETURNING c.expires_at INTO renewed;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN renewed;
END
$$;

-- The challenges a poll still has to read, each with the offset of its bot and the salt its token was sealed with (none
-- for a workspace whose salt was deleted: its token cannot be opened).
CREATE FUNCTION app.connect_challenge_open_due(p_limit integer)
RETURNS TABLE (
  id uuid, workspace_id uuid, provider_id text, bot_digest bytea, update_offset bigint, format_version integer,
  key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea,
  salt bytea)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'job' OR prior IS DISTINCT FROM 'connect_challenge_poll' THEN
    RAISE EXCEPTION 'connect_challenge_open_due: refused' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'connect_challenge_open_due: the limit is 1 to 100' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'connect_challenge_open_due', true);
  -- A token nobody finished is not kept: an hour after its challenge ended it is emptied (until then a new word may
  -- still be asked for without pasting it again).
  UPDATE app.connect_challenges AS c SET format_version = NULL, key_id = NULL, iv = NULL, ciphertext = NULL,
      auth_tag = NULL, wrap_iv = NULL, wrap_tag = NULL, wrapped_dek = NULL
    WHERE c.id IN (
      SELECT e.id FROM app.connect_challenges AS e
        WHERE e.ciphertext IS NOT NULL AND e.expires_at < clock_timestamp() - interval '1 hour'
        ORDER BY e.id FOR UPDATE);
  RETURN QUERY
    SELECT c.id, c.workspace_id, c.provider_id, c.bot_digest, b.update_offset, c.format_version, c.key_id, c.iv,
        c.ciphertext, c.auth_tag, c.wrap_iv, c.wrap_tag, c.wrapped_dek, s.salt
      FROM app.connect_challenges AS c
      JOIN app.bot_claims AS b ON b.bot_digest = c.bot_digest AND b.workspace_id = c.workspace_id
      LEFT JOIN app.workspace_key_salts AS s ON s.workspace_id = c.workspace_id
      WHERE c.consumed_at IS NULL AND c.expires_at > clock_timestamp() AND c.matched_chat_id IS NULL
        AND c.ciphertext IS NOT NULL
      ORDER BY c.id LIMIT p_limit;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Moves the offset of the bot forward (never back) and, when an update carried a word, records the chat on the one
-- unspent challenge of that bot that holds the word. NULL when no challenge matched.
CREATE FUNCTION app.connect_challenge_match(
  p_bot_digest bytea, p_code_hash bytea, p_chat_id text, p_chat_title text, p_next_offset bigint)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  matched uuid;
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'job' OR prior IS DISTINCT FROM 'connect_challenge_poll' THEN
    RAISE EXCEPTION 'connect_challenge_match: refused' USING ERRCODE = '42501';
  END IF;
  IF p_next_offset IS NULL OR p_next_offset < 0 THEN
    RAISE EXCEPTION 'connect_challenge_match: the offset is not negative' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'connect_challenge_match', true);
  UPDATE app.bot_claims AS b SET update_offset = greatest(b.update_offset, p_next_offset)
    WHERE b.bot_digest = p_bot_digest;
  IF p_code_hash IS NOT NULL THEN
    UPDATE app.connect_challenges AS c SET matched_chat_id = p_chat_id, matched_title = p_chat_title
      WHERE c.bot_digest = p_bot_digest AND c.code_hash = p_code_hash AND c.consumed_at IS NULL
        AND c.expires_at > clock_timestamp() AND c.matched_chat_id IS NULL AND c.ciphertext IS NOT NULL
      RETURNING c.id INTO matched;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN matched;
END
$$;

-- What the wizard polls: no row for a challenge that is not the workspace's.
CREATE FUNCTION app.connect_challenge_status(workspace_id uuid, provider_id text, challenge_id uuid)
RETURNS TABLE (state text, matched_title text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
BEGIN
  PERFORM set_config('app.job_purpose', 'connect_challenge_status', true);
  IF app.principal_kind() IS DISTINCT FROM 'user' OR caller IS NULL
     OR app.tenancy_rank(connect_challenge_status.workspace_id, caller) < 4 THEN
    RAISE EXCEPTION 'connect_challenge_status: refused' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT CASE
        WHEN c.consumed_at IS NOT NULL AND c.matched_chat_id IS NOT NULL THEN 'done'
        WHEN c.consumed_at IS NOT NULL THEN 'ended'
        WHEN c.expires_at <= clock_timestamp() THEN 'expired'
        WHEN c.matched_chat_id IS NOT NULL THEN 'matched'
        ELSE 'waiting' END,
      c.matched_title
      FROM app.connect_challenges AS c
      WHERE c.id = connect_challenge_status.challenge_id AND c.workspace_id = connect_challenge_status.workspace_id
        AND c.provider_id = connect_challenge_status.provider_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- One UPDATE, so of two concurrent takers one gets the row (PostgreSQL 18 Read Committed re-reads the WHERE). No row
-- covers every miss alike: wrong workspace, provider or word, no chat answered yet, already taken, expired.
CREATE FUNCTION app.connect_challenge_take(workspace_id uuid, provider_id text, challenge_id uuid, code_hash bytea)
RETURNS TABLE (
  id uuid, channel_id uuid, bot_digest bytea, matched_chat_id text, matched_title text,
  format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea,
  wrapped_dek bytea)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'connect_challenge_take', true);
  PERFORM app.credential_caller(connect_challenge_take.workspace_id);
  RETURN QUERY
    WITH taken AS (
      UPDATE app.connect_challenges AS c SET consumed_at = clock_timestamp()
        WHERE c.id = connect_challenge_take.challenge_id AND c.workspace_id = connect_challenge_take.workspace_id
          AND c.provider_id = connect_challenge_take.provider_id AND c.code_hash = connect_challenge_take.code_hash AND c.consumed_at IS NULL
          AND c.expires_at > clock_timestamp() AND c.matched_chat_id IS NOT NULL AND c.ciphertext IS NOT NULL
        RETURNING c.*)
    SELECT t.id, t.channel_id, t.bot_digest, t.matched_chat_id, t.matched_title, t.format_version,
        t.key_id, t.iv, t.ciphertext, t.auth_tag, t.wrap_iv, t.wrap_tag, t.wrapped_dek
      FROM taken AS t;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The identity key makes a concurrent first connect wait for the first and reuse its row. A connect that names a
-- taken challenge claims the bot again, so a claim lost while the person waited is never taken from another workspace.
-- The answer carries the generation the next credential must carry. A reconnect that names a different identity is
-- refused with the generic SH409, which names nothing.
CREATE FUNCTION app.channel_connect(
  workspace_id uuid, provider_id text, account_kind text, provider_account_id text, instance_host text,
  display_name text, handle text, avatar text, reconnect_channel_id uuid, request_id text, ip_hmac bytea,
  taken_challenge_id uuid DEFAULT NULL)
RETURNS TABLE (channel_id uuid, next_generation integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  found_id uuid;
  newest integer;
  org uuid;
  digest bytea;
BEGIN
  PERFORM set_config('app.job_purpose', 'channel_connect', true);
  PERFORM app.credential_caller(channel_connect.workspace_id);
  IF channel_connect.reconnect_channel_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.channels AS c
       WHERE c.workspace_id = channel_connect.workspace_id AND c.id = channel_connect.reconnect_channel_id
         AND c.provider_id = channel_connect.provider_id
         AND c.provider_account_id = channel_connect.provider_account_id) THEN
    RAISE EXCEPTION 'channel_connect: this account cannot be connected here' USING ERRCODE = 'SH409';
  END IF;
  IF channel_connect.taken_challenge_id IS NOT NULL THEN
    SELECT c.bot_digest INTO digest FROM app.connect_challenges AS c
      WHERE c.id = channel_connect.taken_challenge_id AND c.workspace_id = channel_connect.workspace_id
        AND c.provider_id = channel_connect.provider_id AND c.consumed_at IS NOT NULL AND c.ciphertext IS NOT NULL;
    IF digest IS NULL OR NOT app.bot_claim(digest, channel_connect.workspace_id) THEN
      RAISE EXCEPTION 'channel_connect: this account cannot be connected here' USING ERRCODE = 'SH409';
    END IF;
  END IF;
  INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, instance_host, display_name,
      handle, avatar)
    VALUES (channel_connect.workspace_id, channel_connect.provider_id, channel_connect.account_kind,
      channel_connect.provider_account_id, channel_connect.instance_host, channel_connect.display_name,
      channel_connect.handle, channel_connect.avatar)
    ON CONFLICT ON CONSTRAINT channels_identity_key DO NOTHING;
  SELECT c.id INTO found_id FROM app.channels AS c
    WHERE c.workspace_id = channel_connect.workspace_id AND c.provider_id = channel_connect.provider_id
      AND c.provider_account_id = channel_connect.provider_account_id FOR UPDATE;
  UPDATE app.channels AS c SET instance_host = channel_connect.instance_host, display_name = channel_connect.display_name,
      handle = channel_connect.handle, avatar = channel_connect.avatar
    WHERE c.id = found_id;
  SELECT coalesce(max(k.generation), 0) + 1 INTO newest FROM app.channel_credentials AS k
    WHERE k.workspace_id = channel_connect.workspace_id AND k.channel_id = found_id
      AND k.kind IN ('channel_token', 'bot_token', 'webhook_url') AND k.state IN ('active', 'read_only');
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = channel_connect.workspace_id;
  PERFORM app.audit_append(channel_connect.workspace_id, org, coalesce(app.principal_kind(), 'job'),
    coalesce(app.principal_id()::text, 'job'), 'channel.connected', 'channel', found_id::text,
    channel_connect.request_id, channel_connect.ip_hmac,
    jsonb_build_object('provider_id', channel_connect.provider_id));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN QUERY SELECT found_id, newest;
END
$$;

-- expected_generation is the current one (0 for none) and the row moves to the next. A generation that is not the next
-- is refused (SH409): the AAD binds it, so a stale seal must never land. The kind is the one the value was sealed with.
-- A bot token comes with the challenge it was held on, whose sealed columns are emptied in the same statement batch and
-- whose bot the credential keeps the digest of.
CREATE FUNCTION app.credential_put(
  workspace_id uuid, channel_id uuid, expected_generation integer, format_version integer, key_id text, iv bytea,
  ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea, access_expires_at timestamptz,
  refresh_expires_at timestamptz, refresh_token_digest text, manifest_digest text, api_version text,
  sunset_at timestamptz, capabilities jsonb, limits jsonb, request_id text, ip_hmac bytea,
  secret_kind text DEFAULT 'channel_token', taken_challenge_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  prior text := current_setting('app.job_purpose', true);
  current_generation integer;
  digest bytea;
BEGIN
  PERFORM set_config('app.job_purpose', 'credential_put', true);
  PERFORM app.credential_caller(credential_put.workspace_id);
  IF credential_put.secret_kind NOT IN ('channel_token', 'bot_token', 'webhook_url')
     OR (credential_put.taken_challenge_id IS NOT NULL) <> (credential_put.secret_kind = 'bot_token') THEN
    RAISE EXCEPTION 'credential_put: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM app.channels AS c
    WHERE c.workspace_id = credential_put.workspace_id AND c.id = credential_put.channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credential_put: refused' USING ERRCODE = '42501';
  END IF;
  IF credential_put.taken_challenge_id IS NOT NULL THEN
    SELECT c.bot_digest INTO digest FROM app.connect_challenges AS c
      WHERE c.id = credential_put.taken_challenge_id AND c.workspace_id = credential_put.workspace_id
        AND c.consumed_at IS NOT NULL AND c.ciphertext IS NOT NULL;
    IF digest IS NULL THEN
      RAISE EXCEPTION 'credential_put: refused' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT k.generation INTO current_generation FROM app.channel_credentials AS k
    WHERE k.workspace_id = credential_put.workspace_id AND k.channel_id = credential_put.channel_id
      AND k.kind = credential_put.secret_kind AND k.state IN ('active', 'read_only') FOR UPDATE;
  IF coalesce(current_generation, 0) <> credential_put.expected_generation THEN
    RAISE EXCEPTION 'credential_put: not the next generation' USING ERRCODE = 'SH409';
  END IF;
  INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv,
      ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, access_expires_at, refresh_expires_at,
      refresh_token_digest, bot_digest)
    VALUES (credential_put.workspace_id, credential_put.channel_id, credential_put.expected_generation + 1,
      credential_put.secret_kind, credential_put.format_version, credential_put.key_id, credential_put.iv,
      credential_put.ciphertext, credential_put.auth_tag, credential_put.wrap_iv, credential_put.wrap_tag,
      credential_put.wrapped_dek, credential_put.access_expires_at, credential_put.refresh_expires_at,
      credential_put.refresh_token_digest, digest)
    ON CONFLICT (workspace_id, channel_id, kind) WHERE state IN ('active', 'read_only') DO UPDATE SET
      generation = EXCLUDED.generation, state = 'active', format_version = EXCLUDED.format_version,
      key_id = EXCLUDED.key_id, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, auth_tag = EXCLUDED.auth_tag,
      wrap_iv = EXCLUDED.wrap_iv, wrap_tag = EXCLUDED.wrap_tag, wrapped_dek = EXCLUDED.wrapped_dek,
      access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
      refresh_token_digest = EXCLUDED.refresh_token_digest, bot_digest = EXCLUDED.bot_digest, refreshing_until = NULL,
      refresh_owner = NULL, refresh_attempt_digest = NULL, refresh_attempt_outcome = NULL;
  IF credential_put.taken_challenge_id IS NOT NULL THEN
    UPDATE app.connect_challenges AS c SET format_version = NULL, key_id = NULL, iv = NULL, ciphertext = NULL,
        auth_tag = NULL, wrap_iv = NULL, wrap_tag = NULL, wrapped_dek = NULL
      WHERE c.id = credential_put.taken_challenge_id;
  END IF;
  UPDATE app.channels AS c SET token_expires_at = credential_put.access_expires_at
    WHERE c.workspace_id = credential_put.workspace_id AND c.id = credential_put.channel_id;
  -- An administrator's disable outlives a reconnect: only enable lifts it.
  UPDATE app.channels AS c SET connection_state = 'connected', state_reason = NULL, reconnect_deadline = NULL,
      disconnected_at = NULL
    WHERE c.workspace_id = credential_put.workspace_id AND c.id = credential_put.channel_id
      AND c.connection_state <> 'disabled';
  PERFORM app.channel_health_record(credential_put.workspace_id, credential_put.channel_id, NULL,
    credential_put.manifest_digest, credential_put.api_version, credential_put.sunset_at, credential_put.capabilities,
    credential_put.limits);
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- With no active row or with the salt row deleted (crypto-shred) it answers no row at all, so no sealed field leaves
-- without its salt. It names the kind the value was sealed with and the channel's provider, which the worker role
-- cannot read from the channel row.
CREATE FUNCTION app.credential_open(workspace_id uuid, channel_id uuid)
RETURNS TABLE (
  generation integer, format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea,
  wrap_tag bytea, wrapped_dek bytea, access_expires_at timestamptz, refresh_expires_at timestamptz,
  refresh_token_digest text, salt bytea, provider_id text, kind text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'credential_open', true);
  PERFORM app.credential_caller(credential_open.workspace_id);
  RETURN QUERY
    SELECT k.generation, k.format_version, k.key_id, k.iv, k.ciphertext, k.auth_tag, k.wrap_iv, k.wrap_tag,
        k.wrapped_dek, k.access_expires_at, k.refresh_expires_at, k.refresh_token_digest, s.salt, c.provider_id, k.kind
      FROM app.channel_credentials AS k
      JOIN app.workspace_key_salts AS s ON s.workspace_id = k.workspace_id
      JOIN app.channels AS c ON c.workspace_id = k.workspace_id AND c.id = k.channel_id
      WHERE k.workspace_id = credential_open.workspace_id AND k.channel_id = credential_open.channel_id
        AND k.kind IN ('channel_token', 'bot_token', 'webhook_url') AND k.state = 'active';
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Enable restores `connected` only for a channel that was connected when it was disabled (a channel disabled before
-- the state was kept counts as connected) and that holds a usable credential: an active token, bot token or webhook URL
-- whose refresh token has not expired. Otherwise it is needs_reconnect with a 30-day window.
CREATE OR REPLACE FUNCTION app.channel_enable(workspace_id uuid, channel_id uuid, request_id text, ip_hmac bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  target record;
  org uuid;
  usable boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'channel_enable', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'channel_enable: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM app.tenancy_enter('channel_enable', channel_enable.workspace_id, caller, 4);
  SELECT c.connection_state, c.provider_id, c.disabled_from_state INTO target FROM app.channels AS c
    WHERE c.workspace_id = channel_enable.workspace_id AND c.id = channel_enable.channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_enable: refused' USING ERRCODE = '42501';
  END IF;
  IF target.connection_state <> 'disabled' THEN
    RAISE EXCEPTION 'channel_enable: not_disabled' USING ERRCODE = 'SH409';
  END IF;
  SELECT coalesce(target.disabled_from_state, 'connected') = 'connected' AND EXISTS (
      SELECT 1 FROM app.channel_credentials AS k
      WHERE k.workspace_id = channel_enable.workspace_id AND k.channel_id = channel_enable.channel_id
        AND k.kind IN ('channel_token', 'bot_token', 'webhook_url') AND k.state = 'active'
        AND (k.refresh_expires_at IS NULL OR k.refresh_expires_at > clock_timestamp())) INTO usable;
  UPDATE app.channels AS c SET state_reason = NULL, disabled_from_state = NULL,
      connection_state = CASE WHEN usable THEN 'connected' ELSE 'needs_reconnect' END,
      reconnect_deadline = CASE WHEN usable THEN NULL
        ELSE coalesce(c.reconnect_deadline, clock_timestamp() + interval '30 days') END
    WHERE c.workspace_id = channel_enable.workspace_id AND c.id = channel_enable.channel_id;
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = channel_enable.workspace_id;
  PERFORM app.audit_append(channel_enable.workspace_id, org, 'user', caller::text, 'channel.enabled', 'channel',
    channel_enable.channel_id::text, channel_enable.request_id, channel_enable.ip_hmac,
    jsonb_build_object('provider_id', target.provider_id));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

CREATE OR REPLACE FUNCTION app.sealed_key_ids()
RETURNS TABLE (key_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'sealed_key_ids', true);
  RETURN QUERY
    SELECT e.link_key_id FROM app.email_outbox AS e WHERE e.link_ciphertext IS NOT NULL
    UNION
    SELECT k.key_id FROM app.channel_credentials AS k
    UNION
    SELECT f.key_id FROM app.oauth_flows AS f
    UNION
    SELECT c.key_id FROM app.connect_challenges AS c WHERE c.key_id IS NOT NULL
    UNION
    SELECT a.secret_key_id FROM app.provider_instance_apps AS a
    UNION
    SELECT p.secret_key_id FROM app.provider_apps AS p;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.bot_claim_live(bytea), app.bot_claim(bytea, uuid), app.bot_claim_release(),
  app.connect_challenge_put(uuid, uuid, text, bytea, bytea, uuid, integer, text, bytea, bytea, bytea, bytea, bytea,
    bytea),
  app.connect_challenge_renew(uuid, text, uuid, bytea), app.connect_challenge_open_due(integer),
  app.connect_challenge_match(bytea, bytea, text, text, bigint), app.connect_challenge_status(uuid, text, uuid),
  app.connect_challenge_take(uuid, text, uuid, bytea),
  app.channel_connect(uuid, text, text, text, text, text, text, text, uuid, text, bytea, uuid),
  app.credential_put(uuid, uuid, integer, integer, text, bytea, bytea, bytea, bytea, bytea, bytea, timestamptz,
    timestamptz, text, text, text, timestamptz, jsonb, jsonb, text, bytea, text, uuid),
  app.credential_open(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.connect_challenge_put(uuid, uuid, text, bytea, bytea, uuid, integer, text, bytea, bytea, bytea, bytea, bytea,
    bytea),
  app.connect_challenge_renew(uuid, text, uuid, bytea), app.connect_challenge_status(uuid, text, uuid) TO shoutory_app;
GRANT EXECUTE ON FUNCTION app.connect_challenge_open_due(integer),
  app.connect_challenge_match(bytea, bytea, text, text, bigint) TO shoutory_worker;
GRANT EXECUTE ON FUNCTION app.connect_challenge_take(uuid, text, uuid, bytea),
  app.channel_connect(uuid, text, text, text, text, text, text, text, uuid, text, bytea, uuid),
  app.credential_put(uuid, uuid, integer, integer, text, bytea, bytea, bytea, bytea, bytea, bytea, timestamptz,
    timestamptz, text, text, text, timestamptz, jsonb, jsonb, text, bytea, text, uuid),
  app.credential_open(uuid, uuid) TO shoutory_app, shoutory_worker;
GRANT EXECUTE ON FUNCTION app.bot_claim_release() TO shoutory_owner;
RESET ROLE;

CREATE TRIGGER bot_claim_release AFTER DELETE ON app.channel_credentials
  FOR EACH ROW EXECUTE FUNCTION app.bot_claim_release();
-- Creating the trigger needed the privilege; firing it does not.
SET ROLE shoutory_definer;
REVOKE EXECUTE ON FUNCTION app.bot_claim_release() FROM shoutory_owner;
RESET ROLE;
