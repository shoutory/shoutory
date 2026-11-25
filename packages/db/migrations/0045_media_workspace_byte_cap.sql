-- A register states the size it will upload, and is refused when the workspace's stored and promised bytes would pass
-- the operator's cap. Stored bytes are the live originals, the ready derivatives, the sizes pending uploads declared,
-- and deleted originals whose object is still on disk.
SET ROLE shoutory_definer;

DROP FUNCTION app.media_register(uuid, text, text, text, text, text, integer);

CREATE FUNCTION app.media_register(
  workspace_id uuid, file_name text, mime text, source text, source_ref text, multipart_upload_id text,
  part_size integer, declared_size bigint, workspace_max_bytes bigint)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  new_id constant uuid := uuidv7();
  ws constant uuid := media_register.workspace_id;
BEGIN
  PERFORM set_config('app.job_purpose', 'media_register', true);
  PERFORM app.media_caller(ws, 3, false);
  IF media_register.declared_size IS NULL OR media_register.declared_size NOT BETWEEN 1 AND 5368709120 THEN
    RAISE EXCEPTION 'media_register: a size of 1 byte to 5 GiB is required' USING ERRCODE = '22023';
  END IF;
  -- The workspace row lock orders concurrent registers, so each count sees the bytes the one before it promised.
  PERFORM 1 FROM app.workspaces AS w WHERE w.id = ws FOR NO KEY UPDATE;
  IF (SELECT count(*) FROM app.media_assets AS a WHERE a.workspace_id = ws AND a.state = 'pending_upload') >= 100 THEN
    RAISE EXCEPTION 'media_register: at most 100 pending uploads' USING ERRCODE = '53400';
  END IF;
  IF media_register.workspace_max_bytes IS NOT NULL
     -- A deleted duplicate keeps its object on disk with no stored size, so its declared size stands in.
     AND (SELECT coalesce(sum(coalesce(a.byte_size, (SELECT max(u.declared_size) FROM app.media_uploads AS u
            WHERE u.workspace_id = ws AND u.media_id = a.id))), 0) FROM app.media_assets AS a
          WHERE a.workspace_id = ws AND (a.state IN ('uploaded', 'scanning', 'processing', 'ready')
            OR (a.state = 'deleted' AND a.object_removed_at IS NULL)))
       + (SELECT coalesce(sum(d.byte_size), 0) FROM app.media_derivatives AS d
          WHERE d.workspace_id = ws AND d.state = 'ready')
       + (SELECT coalesce(sum(u.declared_size), 0) FROM app.media_uploads AS u
          JOIN app.media_assets AS a ON a.workspace_id = u.workspace_id AND a.id = u.media_id
          WHERE u.workspace_id = ws AND a.state = 'pending_upload')
       + media_register.declared_size > media_register.workspace_max_bytes THEN
    RAISE EXCEPTION 'media_register: storage_full' USING ERRCODE = 'SH422';
  END IF;
  INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, source_ref, created_by)
    VALUES (new_id, ws, 'ws/' || ws::text || '/' || new_id::text || '/1/original', media_register.file_name,
      media_register.mime, media_register.source, media_register.source_ref, app.principal_id());
  INSERT INTO app.media_uploads (workspace_id, media_id, multipart_upload_id, part_size, declared_size, expires_at)
    VALUES (ws, new_id, media_register.multipart_upload_id, media_register.part_size, media_register.declared_size,
      clock_timestamp() + interval '24 hours');
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;

REVOKE ALL ON FUNCTION app.media_register(uuid, text, text, text, text, text, integer, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_register(uuid, text, text, text, text, text, integer, bigint, bigint)
  TO shoutory_app;

-- A stored object larger than the size its register declared is refused, so the cap cannot be passed by declaring
-- little and uploading more. An upload session from before sizes were declared has none and is not checked.
CREATE OR REPLACE FUNCTION app.media_mark_uploaded(
  workspace_id uuid, asset_id uuid, digest bytea, byte_size bigint, mime text)
RETURNS TABLE (outcome text, live_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  was text;
  existing uuid;
  declared bigint;
BEGIN
  PERFORM set_config('app.job_purpose', 'media_mark_uploaded', true);
  PERFORM app.media_caller(media_mark_uploaded.workspace_id, 3, false);
  SELECT a.state INTO was FROM app.media_assets AS a
    WHERE a.workspace_id = media_mark_uploaded.workspace_id AND a.id = media_mark_uploaded.asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  IF was <> 'pending_upload' THEN
    RAISE EXCEPTION 'media_mark_uploaded: the asset is not a pending upload' USING ERRCODE = 'SH409';
  END IF;
  IF media_mark_uploaded.digest IS NULL OR octet_length(media_mark_uploaded.digest) <> 32 THEN
    RAISE EXCEPTION 'media_mark_uploaded: the hash must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  SELECT u.declared_size INTO declared FROM app.media_uploads AS u
    WHERE u.workspace_id = media_mark_uploaded.workspace_id AND u.media_id = media_mark_uploaded.asset_id
      AND u.completed_at IS NULL;
  IF media_mark_uploaded.byte_size > declared THEN
    RAISE EXCEPTION 'media_mark_uploaded: too_large' USING ERRCODE = 'SH422';
  END IF;
  BEGIN
    UPDATE app.media_assets AS a SET sha256 = media_mark_uploaded.digest, byte_size = media_mark_uploaded.byte_size,
        mime = media_mark_uploaded.mime, state = 'uploaded'
      WHERE a.workspace_id = media_mark_uploaded.workspace_id AND a.id = media_mark_uploaded.asset_id;
    existing := media_mark_uploaded.asset_id;
    outcome := 'ok';
  EXCEPTION WHEN unique_violation THEN
    SELECT a.id INTO existing FROM app.media_assets AS a
      WHERE a.workspace_id = media_mark_uploaded.workspace_id AND a.sha256 = media_mark_uploaded.digest
        AND a.state IN ('uploaded', 'scanning', 'processing', 'ready') ORDER BY a.created_at LIMIT 1;
    -- The live asset was deleted between the violation and this read: the caller retries.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'media_mark_uploaded: the live asset is gone, try again' USING ERRCODE = 'SH409';
    END IF;
    UPDATE app.media_assets AS a SET state = 'deleted', deleted_at = clock_timestamp()
      WHERE a.workspace_id = media_mark_uploaded.workspace_id AND a.id = media_mark_uploaded.asset_id;
    outcome := 'duplicate';
  END;
  UPDATE app.media_uploads AS u SET completed_at = clock_timestamp()
    WHERE u.workspace_id = media_mark_uploaded.workspace_id AND u.media_id = media_mark_uploaded.asset_id
      AND u.completed_at IS NULL;
  IF outcome = 'ok' THEN
    INSERT INTO app.outbox (workspace_id, type, payload)
      VALUES (media_mark_uploaded.workspace_id, 'media.uploaded',
        jsonb_build_object('media_id', media_mark_uploaded.asset_id));
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  live_id := existing;
  RETURN NEXT;
END
$$;
RESET ROLE;

CALL app.grant_purposes('media_derivatives', 'SELECT', ARRAY['media_register']);
CALL app.grant_purposes('media_uploads', 'SELECT', ARRAY['media_register']);
