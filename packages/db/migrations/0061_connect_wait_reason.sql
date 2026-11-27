-- A chat can send the word before the bot is able to use the chat (it may not post messages there yet). The poll holds
-- the word for a closed reason; the challenge stays open and unmatched, and the wizard tells the person what to fix.
ALTER TABLE app.connect_challenges ADD COLUMN wait_reason text;
-- shoutory:accepted-lock the table holds only challenges younger than a day, so the scan under the lock is short
ALTER TABLE app.connect_challenges
  ADD CONSTRAINT connect_challenges_wait_reason_check CHECK (wait_reason IN ('bot_cannot_post'));

GRANT UPDATE (wait_reason) ON app.connect_challenges TO shoutory_definer;
CALL app.grant_purposes('bot_claims', 'SELECT', ARRAY['connect_challenge_hold']);
CALL app.grant_purposes('bot_claims', 'UPDATE', ARRAY['connect_challenge_hold']);
CALL app.grant_purposes('connect_challenges', 'SELECT', ARRAY['connect_challenge_hold']);
CALL app.grant_purposes('connect_challenges', 'UPDATE', ARRAY['connect_challenge_hold']);

DROP FUNCTION app.connect_challenge_status(uuid, text, uuid);

SET ROLE shoutory_definer;

-- Records why the open challenge of that workspace, provider and bot whose word it is cannot be matched yet. The bot
-- claim is locked before the challenge row, as the match does. NULL when no open, unmatched challenge holds the word.
CREATE FUNCTION app.connect_challenge_hold(
  p_workspace_id uuid, p_provider_id text, p_bot_digest bytea, p_code_hash bytea, p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  held uuid;
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'job' OR prior IS DISTINCT FROM 'connect_challenge_poll' THEN
    RAISE EXCEPTION 'connect_challenge_hold: refused' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('bot_cannot_post') THEN
    RAISE EXCEPTION 'connect_challenge_hold: the reason is not one of the known ones' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'connect_challenge_hold', true);
  PERFORM 1 FROM app.bot_claims AS b
    WHERE b.bot_digest = p_bot_digest AND b.workspace_id = p_workspace_id FOR UPDATE;
  UPDATE app.connect_challenges AS c SET wait_reason = p_reason
    WHERE c.workspace_id = p_workspace_id AND c.provider_id = p_provider_id AND c.bot_digest = p_bot_digest
      AND c.code_hash = p_code_hash AND c.consumed_at IS NULL AND c.expires_at > clock_timestamp()
      AND c.matched_chat_id IS NULL AND c.ciphertext IS NOT NULL
    RETURNING c.id INTO held;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN held;
END
$$;

-- A new word starts again, so the reason of the old one goes.
CREATE OR REPLACE FUNCTION app.connect_challenge_renew(
  workspace_id uuid, provider_id text, challenge_id uuid, code_hash bytea)
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
      expires_at = clock_timestamp() + interval '10 minutes', wait_reason = NULL
    WHERE c.id = connect_challenge_renew.challenge_id AND c.consumed_at IS NULL AND c.matched_chat_id IS NULL
      AND c.ciphertext IS NOT NULL
    RETURNING c.expires_at INTO renewed;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN renewed;
END
$$;

-- What the wizard polls: no row for a challenge that is not the workspace's. The reason shows only while the
-- challenge is still waiting for a word.
CREATE FUNCTION app.connect_challenge_status(workspace_id uuid, provider_id text, challenge_id uuid)
RETURNS TABLE (state text, matched_title text, reason text)
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
      c.matched_title,
      CASE WHEN c.consumed_at IS NULL AND c.expires_at > clock_timestamp() AND c.matched_chat_id IS NULL
        THEN c.wait_reason END
      FROM app.connect_challenges AS c
      WHERE c.id = connect_challenge_status.challenge_id AND c.workspace_id = connect_challenge_status.workspace_id
        AND c.provider_id = connect_challenge_status.provider_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.connect_challenge_hold(uuid, text, bytea, bytea, text),
  app.connect_challenge_status(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.connect_challenge_hold(uuid, text, bytea, bytea, text) TO shoutory_worker;
GRANT EXECUTE ON FUNCTION app.connect_challenge_status(uuid, text, uuid) TO shoutory_app;
RESET ROLE;
