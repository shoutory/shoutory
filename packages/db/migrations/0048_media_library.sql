-- A member deletes a medium only through media_delete, which refuses one a post, a pending send or the workspace avatar
-- still needs. The upload progress definer had no caller: the parts of an upload are read from storage.
DROP POLICY media_upload_progress_select ON app.workspaces;
DROP POLICY media_upload_progress_select ON app.workspace_members;
DROP POLICY media_upload_progress_select ON app.organization_members;
DROP POLICY media_upload_progress_select ON app.roles;
DROP POLICY media_upload_progress_select ON app.media_assets;
DROP POLICY media_upload_progress_update ON app.media_assets;
DROP POLICY media_upload_progress_select ON app.media_uploads;
DROP POLICY media_upload_progress_update ON app.media_uploads;
DROP FUNCTION app.media_upload_progress(uuid, uuid, integer[]);
ALTER TABLE app.media_uploads DROP COLUMN parts_done;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles', 'media_assets',
    'post_media', 'operation_media', 'operations'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['media_delete']);
  END LOOP;
END
$$;
CALL app.grant_purposes('media_assets', 'UPDATE', ARRAY['media_delete']);

SET ROLE shoutory_definer;

-- The row lock waits for a post attach or a send pin of the medium (both take FOR SHARE) and makes them wait in turn,
-- so a deleted medium is never attached. The library flag is cleared first because a library medium counts as used;
-- a refusal rolls it back. A deleted medium is refused as an unknown one.
CREATE FUNCTION app.media_delete(workspace_id uuid, asset_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  was text;
BEGIN
  PERFORM set_config('app.job_purpose', 'media_delete', true);
  PERFORM app.media_caller(media_delete.workspace_id, 3, false);
  SELECT a.state INTO was FROM app.media_assets AS a
    WHERE a.workspace_id = media_delete.workspace_id AND a.id = media_delete.asset_id FOR UPDATE;
  IF NOT FOUND OR was = 'deleted' THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  IF was NOT IN ('ready', 'rejected') THEN
    RAISE EXCEPTION 'media_delete: not_deletable' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.media_assets AS a SET in_library = false
    WHERE a.workspace_id = media_delete.workspace_id AND a.id = media_delete.asset_id;
  IF NOT EXISTS (SELECT 1 FROM app.media_unused(ARRAY[media_delete.workspace_id], media_delete.asset_id)) THEN
    RAISE EXCEPTION 'media_delete: in_use' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.media_assets AS a SET state = 'deleted', deleted_at = clock_timestamp()
    WHERE a.workspace_id = media_delete.workspace_id AND a.id = media_delete.asset_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- A deleted medium cannot be edited, and a rejected one cannot join the library.
CREATE OR REPLACE FUNCTION app.media_set_metadata(
  workspace_id uuid, asset_id uuid, file_name text, tags text[], in_library boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  was text;
BEGIN
  PERFORM set_config('app.job_purpose', 'media_set_metadata', true);
  PERFORM app.media_caller(media_set_metadata.workspace_id, 3, false);
  SELECT a.state INTO was FROM app.media_assets AS a
    WHERE a.workspace_id = media_set_metadata.workspace_id AND a.id = media_set_metadata.asset_id FOR UPDATE;
  IF NOT FOUND OR was = 'deleted' THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  IF was = 'rejected' AND media_set_metadata.in_library THEN
    RAISE EXCEPTION 'media_set_metadata: not_ready' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.media_assets AS a SET file_name = coalesce(media_set_metadata.file_name, a.file_name),
      tags = coalesce(media_set_metadata.tags, a.tags), in_library = coalesce(media_set_metadata.in_library, a.in_library),
      unreferenced_since = CASE WHEN media_set_metadata.in_library THEN NULL ELSE a.unreferenced_since END
    WHERE a.workspace_id = media_set_metadata.workspace_id AND a.id = media_set_metadata.asset_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Deleting a ready or rejected medium is a job's move only; a member goes through media_delete.
CREATE OR REPLACE FUNCTION app.media_advance(
  workspace_id uuid, asset_id uuid, from_state text, to_state text, reject_reason text, facts jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  was text;
  jobs_only boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'media_advance', true);
  PERFORM app.media_caller(media_advance.workspace_id, 3, true);
  SELECT a.state INTO was FROM app.media_assets AS a
    WHERE a.workspace_id = media_advance.workspace_id AND a.id = media_advance.asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  SELECT m.jobs_only INTO jobs_only FROM (VALUES
    ('pending_upload', 'deleted', false), ('uploaded', 'scanning', true), ('uploaded', 'processing', true),
    ('scanning', 'processing', true), ('scanning', 'rejected', true), ('processing', 'ready', true),
    ('processing', 'rejected', true), ('ready', 'deleted', true), ('rejected', 'deleted', true),
    ('uploaded', 'deleted', true), ('scanning', 'deleted', true), ('processing', 'deleted', true)
  ) AS m (from_state, to_state, jobs_only)
    WHERE m.from_state = media_advance.from_state AND m.to_state = media_advance.to_state;
  IF NOT FOUND OR was <> media_advance.from_state THEN
    RAISE EXCEPTION 'media_advance: that move is not allowed' USING ERRCODE = 'SH409';
  END IF;
  IF jobs_only AND app.principal_kind() <> 'job' THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  IF media_advance.to_state = 'rejected' AND media_advance.reject_reason IS NULL THEN
    RAISE EXCEPTION 'media_advance: a rejection needs its reason' USING ERRCODE = '22023';
  END IF;
  IF media_advance.facts IS NOT NULL AND (app.principal_kind() <> 'job'
     OR jsonb_typeof(media_advance.facts) <> 'object') THEN
    RAISE EXCEPTION 'media_advance: facts are the pipeline''s and an object' USING ERRCODE = '22023';
  END IF;
  BEGIN
    UPDATE app.media_assets AS a SET state = media_advance.to_state,
        reject_reason = CASE WHEN media_advance.to_state = 'rejected' THEN media_advance.reject_reason ELSE a.reject_reason END,
        deleted_at = CASE WHEN media_advance.to_state = 'deleted' THEN clock_timestamp() ELSE a.deleted_at END,
        width = coalesce((media_advance.facts ->> 'width')::integer, a.width),
        height = coalesce((media_advance.facts ->> 'height')::integer, a.height),
        duration_ms = coalesce((media_advance.facts ->> 'duration_ms')::integer, a.duration_ms),
        mime = coalesce(media_advance.facts ->> 'mime', a.mime),
        codec_facts = coalesce(media_advance.facts -> 'codec', a.codec_facts)
      WHERE a.workspace_id = media_advance.workspace_id AND a.id = media_advance.asset_id;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'media_advance: a fact is not valid' USING ERRCODE = '22023';
  END;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.media_delete(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_delete(uuid, uuid) TO shoutory_app;
RESET ROLE;
