-- The sweep stamps each credential it lists, so a run starts with those listed least recently and a set of channels
-- that keep failing never hides the rest.
ALTER TABLE app.channel_credentials ADD COLUMN refresh_swept_at timestamptz;
CALL app.grant_purposes('channel_credentials', 'UPDATE', ARRAY['due_token_refreshes']);

SET ROLE shoutory_definer;

-- Only the refresh sweep may call it, and it lists due credentials of every workspace: ids only, nothing secret. Only
-- credentials that hold a refresh token are listed; a token with no expiry is never due. The margin is bounded 60 to
-- 3600 seconds, the limit 1 to 500.
CREATE OR REPLACE FUNCTION app.due_token_refreshes(lim integer, margin_seconds integer)
RETURNS TABLE (workspace_id uuid, channel_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'job' OR prior IS DISTINCT FROM 'credential_refresh' THEN
    RAISE EXCEPTION 'due_token_refreshes: refused' USING ERRCODE = '42501';
  END IF;
  IF lim IS NULL OR lim NOT BETWEEN 1 AND 500 OR margin_seconds IS NULL OR margin_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'due_token_refreshes: the limit is 1 to 500 and the margin 60 to 3600 seconds' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'due_token_refreshes', true);
  RETURN QUERY
    WITH picked AS (
      SELECT k.id
        FROM app.channel_credentials AS k
        JOIN app.channels AS c ON c.workspace_id = k.workspace_id AND c.id = k.channel_id
        WHERE k.kind = 'channel_token' AND k.state = 'active' AND c.connection_state = 'connected'
          AND k.refresh_token_digest IS NOT NULL
          AND k.access_expires_at <= clock_timestamp() + make_interval(secs => due_token_refreshes.margin_seconds)
          AND (k.refreshing_until IS NULL OR k.refreshing_until <= clock_timestamp())
        ORDER BY k.refresh_swept_at NULLS FIRST, k.access_expires_at
        LIMIT due_token_refreshes.lim
        FOR UPDATE OF k SKIP LOCKED
    )
    UPDATE app.channel_credentials AS k SET refresh_swept_at = clock_timestamp()
      FROM picked WHERE k.id = picked.id
      RETURNING k.workspace_id, k.channel_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

RESET ROLE;
