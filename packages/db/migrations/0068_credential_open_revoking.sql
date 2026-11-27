-- The credential a disconnect is ending, for the one revoke call at the provider. It answers the newest credential of the
-- channel that is `revoking`, in the same shape as `credential_open`, which answers only an active one.
CALL app.grant_purposes('channel_credentials', 'SELECT', ARRAY['credential_open_revoking']);
CALL app.grant_purposes('channels', 'SELECT', ARRAY['credential_open_revoking']);
CALL app.grant_purposes('workspace_key_salts', 'SELECT', ARRAY['credential_open_revoking']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['credential_open_revoking']);
CALL app.grant_purposes('workspace_members', 'SELECT', ARRAY['credential_open_revoking']);
CALL app.grant_purposes('organization_members', 'SELECT', ARRAY['credential_open_revoking']);
CALL app.grant_purposes('roles', 'SELECT', ARRAY['credential_open_revoking']);

SET ROLE shoutory_definer;

CREATE FUNCTION app.credential_open_revoking(workspace_id uuid, channel_id uuid)
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
  PERFORM set_config('app.job_purpose', 'credential_open_revoking', true);
  PERFORM app.credential_caller(credential_open_revoking.workspace_id);
  RETURN QUERY
    SELECT k.generation, k.format_version, k.key_id, k.iv, k.ciphertext, k.auth_tag, k.wrap_iv, k.wrap_tag,
        k.wrapped_dek, k.access_expires_at, k.refresh_expires_at, k.refresh_token_digest, s.salt, c.provider_id, k.kind
      FROM app.channel_credentials AS k
      JOIN app.workspace_key_salts AS s ON s.workspace_id = k.workspace_id
      JOIN app.channels AS c ON c.workspace_id = k.workspace_id AND c.id = k.channel_id
      WHERE k.workspace_id = credential_open_revoking.workspace_id AND k.channel_id = credential_open_revoking.channel_id
        AND k.kind IN ('channel_token', 'bot_token', 'webhook_url') AND k.state = 'revoking'
      ORDER BY k.generation DESC LIMIT 1;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.credential_open_revoking(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.credential_open_revoking(uuid, uuid) TO shoutory_app, shoutory_worker;

RESET ROLE;
