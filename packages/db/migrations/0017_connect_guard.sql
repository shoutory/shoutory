-- The guards of the OAuth connect routes: a per-user bucket on the start and on the callback, and the flow writer taking the
-- flow id the service sealed the verifier under and refusing a channel of another provider.

-- The two connect scopes join the throttle. `connect_start` also caps a user's unspent flows (10 per 600 seconds). The
-- scope list and the limits are replaced whole, every earlier row carried (the 0013 way: NOT VALID, then VALIDATE in the
-- same file, on the table that holds only throttle rows).
-- shoutory:accepted-lock the throttle table is small and its rows expire; the lock is held for this migration only
ALTER TABLE app.rate_buckets DROP CONSTRAINT rate_buckets_scope_check;
-- shoutory:accepted-lock same small table, same transaction
ALTER TABLE app.rate_buckets ADD CONSTRAINT rate_buckets_scope_check CHECK (scope IN (
  'login_account', 'login_ip', 'verification_resend', 'invite', 'invite_accept', 'unsubscribe',
  'two_factor', 'password_reset', 'totp_code', 'link_confirm', 'tenant_create', 'connect_start', 'connect_callback',
  'account', 'chat', 'webhook', 'instance', 'app', 'api_principal')) NOT VALID;
-- shoutory:accepted-lock VALIDATE takes SHARE UPDATE EXCLUSIVE and scans the same small table, in the same transaction
ALTER TABLE app.rate_buckets VALIDATE CONSTRAINT rate_buckets_scope_check;

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
    ('unsubscribe', 20, 900),
    ('tenant_create', 10, 86400),
    ('connect_start', 10, 600),
    ('connect_callback', 20, 600)
  ) AS l (name, capacity, refill_seconds) WHERE l.name = scope
$$;
REVOKE ALL ON FUNCTION app.bucket_limits(text) FROM PUBLIC;

-- The flow writer takes the flow id: the service reads it before it seals the verifier, because the sealed object is
-- bound to the flow id as its owner, and the row must carry that id. The checks are the old ones and one more: a channel (a
-- reconnect) must belong to the workspace and to the provider of the flow, and any other channel is refused exactly as
-- a channel of another workspace is.
DROP FUNCTION app.oauth_flow_put(uuid, text, bytea, uuid, text, integer, text, bytea, bytea, bytea, bytea, bytea,
  bytea, text);
CREATE FUNCTION app.oauth_flow_put(
  flow_id uuid, workspace_id uuid, provider_id text, state_hash bytea, channel_id uuid, instance_host text,
  format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea,
  wrapped_dek bytea, request_uri text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
BEGIN
  PERFORM set_config('app.job_purpose', 'oauth_flow_put', true);
  IF app.principal_kind() IS DISTINCT FROM 'user' OR caller IS NULL
     OR app.tenancy_rank(oauth_flow_put.workspace_id, caller) < 4 THEN
    RAISE EXCEPTION 'oauth_flow_put: refused' USING ERRCODE = '42501';
  END IF;
  IF oauth_flow_put.flow_id IS NULL THEN
    RAISE EXCEPTION 'oauth_flow_put: the flow id is required' USING ERRCODE = '22023';
  END IF;
  IF oauth_flow_put.channel_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.channels AS c
       WHERE c.workspace_id = oauth_flow_put.workspace_id AND c.id = oauth_flow_put.channel_id
         AND c.provider_id = oauth_flow_put.provider_id) THEN
    RAISE EXCEPTION 'oauth_flow_put: refused' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.oauth_flows (id, workspace_id, user_id, channel_id, instance_host, provider_id, state_hash,
      format_version, key_id, iv, ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, request_uri, expires_at)
    VALUES (oauth_flow_put.flow_id, oauth_flow_put.workspace_id, caller, oauth_flow_put.channel_id,
      oauth_flow_put.instance_host, oauth_flow_put.provider_id, oauth_flow_put.state_hash,
      oauth_flow_put.format_version, oauth_flow_put.key_id, oauth_flow_put.iv, oauth_flow_put.ciphertext,
      oauth_flow_put.auth_tag, oauth_flow_put.wrap_iv, oauth_flow_put.wrap_tag, oauth_flow_put.wrapped_dek,
      oauth_flow_put.request_uri, clock_timestamp() + interval '10 minutes');
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN oauth_flow_put.flow_id;
END
$$;

REVOKE ALL ON FUNCTION app.oauth_flow_put(uuid, uuid, text, bytea, uuid, text, integer, text, bytea, bytea, bytea,
  bytea, bytea, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.oauth_flow_put(uuid, uuid, text, bytea, uuid, text, integer, text, bytea, bytea, bytea,
  bytea, bytea, bytea, text) TO shoutory_app;
RESET ROLE;
