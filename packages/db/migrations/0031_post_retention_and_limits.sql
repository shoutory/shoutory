-- An autosave is kept 30 days and only the newest 50 of a post; a version the post, a variant or an operation names
-- is never removed, and neither is a version of another kind.
CREATE POLICY retention_seed_insert ON app.retention_classes FOR INSERT TO shoutory_owner WITH CHECK (true);
INSERT INTO app.retention_classes (class, table_name, kind, event_column, retain, partition_unit) VALUES
  ('app.post_versions_autosave', 'app.post_versions', 'window', 'CASE WHEN kind = ''autosave''
    AND NOT EXISTS (SELECT 1 FROM app.posts AS p WHERE p.id = post_versions.post_id
      AND p.current_version_id = post_versions.id)
    AND NOT EXISTS (SELECT 1 FROM app.post_variants AS v WHERE v.workspace_id = post_versions.workspace_id
      AND v.post_id = post_versions.post_id AND v.frozen_version_id = post_versions.id)
    AND NOT EXISTS (SELECT 1 FROM app.operations AS o WHERE o.workspace_id = post_versions.workspace_id
      AND o.frozen_version_id = post_versions.id)
    THEN CASE WHEN EXISTS (SELECT 1 FROM app.post_versions AS n WHERE n.workspace_id = post_versions.workspace_id
      AND n.post_id = post_versions.post_id AND n.kind = ''autosave'' AND n.version_no > post_versions.version_no
      ORDER BY n.version_no OFFSET 49 LIMIT 1)
      THEN ''-infinity''::timestamptz ELSE created_at END END', interval '30 days', NULL);
DROP POLICY retention_seed_insert ON app.retention_classes;
GRANT DELETE ON app.post_versions TO shoutory_definer;
CALL app.grant_purposes('post_versions', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('post_versions', 'DELETE', ARRAY['purge_expired']);
CALL app.grant_purposes('posts', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('post_variants', 'SELECT', ARRAY['purge_expired']);

-- shoutory:accepted-lock the throttle table is small and its rows expire; the lock is held for this migration only
ALTER TABLE app.rate_buckets DROP CONSTRAINT rate_buckets_scope_check;
-- shoutory:accepted-lock same small table, same transaction
ALTER TABLE app.rate_buckets ADD CONSTRAINT rate_buckets_scope_check CHECK (scope IN (
  'login_account', 'login_ip', 'verification_resend', 'invite', 'invite_accept', 'unsubscribe',
  'two_factor', 'password_reset', 'totp_code', 'link_confirm', 'tenant_create', 'connect_start', 'connect_callback',
  'post_autosave', 'account', 'chat', 'webhook', 'instance', 'app', 'api_principal')) NOT VALID;
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
    ('connect_callback', 20, 600),
    ('post_autosave', 120, 60)
  ) AS l (name, capacity, refill_seconds) WHERE l.name = scope
$$;
REVOKE ALL ON FUNCTION app.bucket_limits(text) FROM PUBLIC;
RESET ROLE;

-- A variant's parts are bounded by their size alone; the count is the channel's rule, checked by the app.
-- shoutory:accepted-lock dropping a CHECK takes a brief ACCESS EXCLUSIVE lock and scans nothing
ALTER TABLE app.post_variants DROP CONSTRAINT post_variants_parts_check;
ALTER TABLE app.post_variants ADD CONSTRAINT post_variants_parts_check CHECK (
  jsonb_typeof(parts) = 'array' AND octet_length(parts::text) <= 262144) NOT VALID;
