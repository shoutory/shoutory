-- Both stay empty for an upload of one request. One definer writes them, so the digest the pipeline later proves cannot
-- change between register and complete.
ALTER TABLE app.media_uploads ADD COLUMN declared_sha256 bytea;
ALTER TABLE app.media_uploads ADD COLUMN declared_size bigint;
GRANT UPDATE (multipart_upload_id, declared_sha256, declared_size) ON app.media_uploads TO shoutory_definer;

CALL app.grant_purposes('media_assets', 'SELECT', ARRAY['media_set_multipart']);
-- A row lock (FOR UPDATE) passes the UPDATE policy, so the writer that only locks the asset holds it too.
CALL app.grant_purposes('media_assets', 'UPDATE', ARRAY['media_set_multipart']);
CALL app.grant_purposes('media_uploads', 'SELECT', ARRAY['media_set_multipart']);
CALL app.grant_purposes('media_uploads', 'UPDATE', ARRAY['media_set_multipart']);
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['media_set_multipart']);
  END LOOP;
END
$$;

SET ROLE shoutory_definer;

-- The first writer wins on all three values: the same values again answer the stored upload id, any other value is
-- refused, so the caller that loses aborts its own storage upload. The asset row is locked first, then its session.
CREATE FUNCTION app.media_set_multipart(
  workspace_id uuid, asset_id uuid, upload_id text, digest bytea, byte_size bigint)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  was text;
  have record;
BEGIN
  PERFORM set_config('app.job_purpose', 'media_set_multipart', true);
  PERFORM app.media_caller(media_set_multipart.workspace_id, 3, false);
  IF media_set_multipart.upload_id IS NULL OR char_length(media_set_multipart.upload_id) NOT BETWEEN 1 AND 1024
     OR media_set_multipart.digest IS NULL OR octet_length(media_set_multipart.digest) <> 32
     OR media_set_multipart.byte_size IS NULL OR media_set_multipart.byte_size NOT BETWEEN 1 AND 5368709120 THEN
    RAISE EXCEPTION 'media_set_multipart: the upload id, a 32-byte digest and a size of 1 byte to 5 GiB are required'
      USING ERRCODE = '22023';
  END IF;
  SELECT a.state INTO was FROM app.media_assets AS a
    WHERE a.workspace_id = media_set_multipart.workspace_id AND a.id = media_set_multipart.asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  IF was <> 'pending_upload' THEN
    RAISE EXCEPTION 'media_set_multipart: the asset is not a pending upload' USING ERRCODE = 'SH409';
  END IF;
  SELECT u.multipart_upload_id, u.declared_sha256, u.declared_size INTO have FROM app.media_uploads AS u
    WHERE u.workspace_id = media_set_multipart.workspace_id AND u.media_id = media_set_multipart.asset_id
      AND u.completed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_set_multipart: there is no open upload session' USING ERRCODE = 'SH409';
  END IF;
  IF have.multipart_upload_id IS NULL THEN
    UPDATE app.media_uploads AS u SET multipart_upload_id = media_set_multipart.upload_id,
        declared_sha256 = media_set_multipart.digest, declared_size = media_set_multipart.byte_size
      WHERE u.workspace_id = media_set_multipart.workspace_id AND u.media_id = media_set_multipart.asset_id;
  ELSIF have.multipart_upload_id <> media_set_multipart.upload_id
     OR have.declared_sha256 IS DISTINCT FROM media_set_multipart.digest
     OR have.declared_size IS DISTINCT FROM media_set_multipart.byte_size THEN
    RAISE EXCEPTION 'media_set_multipart: the upload is already recorded with other values' USING ERRCODE = 'SH409';
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN media_set_multipart.upload_id;
END
$$;

REVOKE ALL ON FUNCTION app.media_set_multipart(uuid, uuid, text, bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_set_multipart(uuid, uuid, text, bytea, bigint) TO shoutory_app;
RESET ROLE;
