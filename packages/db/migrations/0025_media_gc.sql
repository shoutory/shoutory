GRANT TRIGGER ON app.post_media TO shoutory_definer;
SET ROLE shoutory_definer;

-- The one rule for the candidate list and the take. `workspaces` NULL reads every workspace, `only_asset` NULL every
-- asset. An operation pins an asset in any state except the terminal ones that sent nothing more, and a superseded
-- operation pins it while its late evidence is watched. A post that names it, the library and the avatar of its
-- workspace pin it too. A saved version's snapshot is not a use. Names are qualified because the helper runs under
-- the purpose of the definer that calls it.
CREATE FUNCTION app.media_gc_due(workspaces uuid[], only_asset uuid)
RETURNS TABLE (workspace_id uuid, asset_id uuid, object_key text, arm text)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH assets AS (
    SELECT a.* FROM app.media_assets AS a
      WHERE (media_gc_due.workspaces IS NULL OR a.workspace_id = ANY (media_gc_due.workspaces))
        AND (media_gc_due.only_asset IS NULL OR a.id = media_gc_due.only_asset)
  ), pinned AS (
    SELECT m.workspace_id, m.media_id FROM app.operation_media AS m
      JOIN app.operations AS o ON o.workspace_id = m.workspace_id AND o.id = m.operation_id
      WHERE (media_gc_due.workspaces IS NULL OR m.workspace_id = ANY (media_gc_due.workspaces))
        AND (media_gc_due.only_asset IS NULL OR m.media_id = media_gc_due.only_asset)
        AND (o.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')
          OR (o.state = 'superseded_after_unknown_outcome'
            AND (o.unverified_until IS NULL OR o.unverified_until > clock_timestamp())))
  ), unused AS (
    SELECT a.workspace_id, a.id AS asset_id, a.object_key, a.state, a.created_at, a.deleted_at, a.object_removed_at
      FROM assets AS a
      WHERE NOT a.in_library
        AND NOT EXISTS (SELECT 1 FROM app.post_media AS pm WHERE pm.workspace_id = a.workspace_id AND pm.media_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM pinned AS p WHERE p.workspace_id = a.workspace_id AND p.media_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM app.workspaces AS w WHERE w.id = a.workspace_id AND w.avatar = a.id)
  )
  SELECT u.workspace_id, u.id, u.object_key, 'pending_upload'::text
    FROM assets AS u WHERE u.state = 'pending_upload' AND u.created_at <= clock_timestamp() - interval '24 hours'
  UNION ALL
  SELECT u.workspace_id, u.asset_id, u.object_key, 'rejected'::text
    FROM unused AS u WHERE u.state = 'rejected' AND u.created_at <= clock_timestamp() - interval '30 days'
  UNION ALL
  SELECT u.workspace_id, u.asset_id, u.object_key, 'unreferenced'::text
    FROM unused AS u WHERE u.state = 'ready' AND u.created_at <= clock_timestamp() - interval '30 days'
  UNION ALL
  SELECT u.workspace_id, u.asset_id, u.object_key, 'deleted'::text
    FROM unused AS u WHERE u.state = 'deleted' AND u.object_removed_at IS NULL
      AND u.deleted_at <= clock_timestamp() - interval '30 days'
$$;

-- The cursor lets a run go on past assets that stay candidates.
DROP FUNCTION app.media_gc_candidates(integer);
CREATE FUNCTION app.media_gc_candidates(lim integer, after_asset uuid DEFAULT NULL)
RETURNS TABLE (workspace_id uuid, asset_id uuid, object_key text, arm text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'job' THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  IF media_gc_candidates.lim IS NULL OR media_gc_candidates.lim NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'media_gc_candidates: the limit is 1 to 500' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'media_gc_candidates', true);
  RETURN QUERY
    SELECT d.workspace_id, d.asset_id, d.object_key, d.arm
      FROM app.media_gc_due(CASE WHEN cardinality(app.ws_ids()) = 0 THEN NULL ELSE app.ws_ids() END, NULL) AS d
      WHERE media_gc_candidates.after_asset IS NULL OR d.asset_id > media_gc_candidates.after_asset
      ORDER BY d.asset_id LIMIT media_gc_candidates.lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The rule is read again under the asset lock, so an asset attached, put in the library or made an avatar since the
-- list was read is not taken. The deleted arm answers its keys and moves nothing: the job retries a failed delete.
CREATE FUNCTION app.media_gc_take(workspace_id uuid, asset_id uuid, arm text)
RETURNS TABLE (object_key text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  was text;
  due boolean;
BEGIN
  PERFORM set_config('app.job_purpose', 'media_gc_take', true);
  PERFORM app.media_caller(media_gc_take.workspace_id, 6, true);
  IF media_gc_take.arm IS NULL OR media_gc_take.arm NOT IN ('pending_upload', 'unreferenced', 'rejected', 'deleted') THEN
    RAISE EXCEPTION 'media_gc_take: the arm is not known' USING ERRCODE = '22023';
  END IF;
  SELECT a.state INTO was FROM app.media_assets AS a
    WHERE a.workspace_id = media_gc_take.workspace_id AND a.id = media_gc_take.asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM app.media_gc_due(ARRAY[media_gc_take.workspace_id], media_gc_take.asset_id) AS d
      WHERE d.arm = media_gc_take.arm) INTO due;
  IF due AND media_gc_take.arm <> 'deleted' THEN
    PERFORM app.media_advance(media_gc_take.workspace_id, media_gc_take.asset_id, was, 'deleted', NULL, NULL);
  END IF;
  IF due THEN
    RETURN QUERY
      SELECT k.object_key FROM (
        SELECT a.object_key, 0 AS ord, ''::text AS profile FROM app.media_assets AS a
          WHERE a.workspace_id = media_gc_take.workspace_id AND a.id = media_gc_take.asset_id
        UNION ALL
        SELECT d.object_key, 1, d.profile FROM app.media_derivatives AS d
          WHERE d.workspace_id = media_gc_take.workspace_id AND d.media_id = media_gc_take.asset_id
      ) AS k ORDER BY k.ord, k.profile;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- FOR SHARE conflicts with the take's FOR UPDATE, so a save and the collection of the same medium are serialized and
-- whichever comes second sees the other's state. A row whose medium does not change is not checked.
CREATE FUNCTION app.post_media_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  was text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.workspace_id = OLD.workspace_id AND NEW.media_id = OLD.media_id THEN
    RETURN NEW;
  END IF;
  PERFORM set_config('app.job_purpose', 'post_media_guard', true);
  SELECT a.state INTO was FROM app.media_assets AS a
    WHERE a.workspace_id = NEW.workspace_id AND a.id = NEW.media_id FOR SHARE;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  IF was IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'post: media_unavailable' USING ERRCODE = 'SH422';
  END IF;
  RETURN NEW;
END
$$;

-- AFTER, so the row-security check and the keys answer first: a medium of another workspace is still refused by its
-- key, and a write the policies refuse is still refused by them.
CREATE TRIGGER post_media_guard AFTER INSERT OR UPDATE OF media_id ON app.post_media
  FOR EACH ROW EXECUTE FUNCTION app.post_media_guard();

REVOKE ALL ON FUNCTION app.media_gc_due(uuid[], uuid), app.media_gc_candidates(integer, uuid),
  app.media_gc_take(uuid, uuid, text), app.post_media_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_gc_candidates(integer, uuid), app.media_gc_take(uuid, uuid, text)
  TO shoutory_worker;
RESET ROLE;
REVOKE TRIGGER ON app.post_media FROM shoutory_definer;

-- A row lock passes the UPDATE policy, so the take and the guard hold it to lock the asset.
CALL app.grant_purposes('media_assets', 'SELECT', ARRAY['media_gc_take', 'post_media_guard']);
CALL app.grant_purposes('media_assets', 'UPDATE', ARRAY['media_gc_take', 'post_media_guard']);
CALL app.grant_purposes('operations', 'SELECT', ARRAY['media_gc_take']);
CALL app.grant_purposes('operation_media', 'SELECT', ARRAY['media_gc_take']);
CALL app.grant_purposes('post_media', 'SELECT', ARRAY['media_gc_take']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['media_gc_candidates', 'media_gc_take']);
CALL app.grant_purposes('media_derivatives', 'SELECT', ARRAY['media_gc_take']);
