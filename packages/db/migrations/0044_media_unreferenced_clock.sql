-- An unused ready medium is collected 30 days after the first collection run that found nothing needing it, not 30
-- days after its upload. NULL means no run has found it unused since its last use; rows from before this column wait
-- one run.
ALTER TABLE app.media_assets ADD COLUMN unreferenced_since timestamptz;
GRANT UPDATE (unreferenced_since) ON app.media_assets TO shoutory_definer;

SET ROLE shoutory_definer;

-- What nothing needs: no post names it, it is not in the library or the avatar of its workspace, and no operation pins
-- it. An operation pins an asset in any state except the terminal ones that sent nothing more, and a superseded
-- operation pins it while its late evidence is watched. A saved version's snapshot is not a use. `workspaces` NULL
-- reads every workspace, `only_asset` NULL every asset. Names are qualified because the helper runs under the purpose
-- of the definer that calls it.
CREATE FUNCTION app.media_unused(workspaces uuid[], only_asset uuid)
RETURNS TABLE (workspace_id uuid, asset_id uuid, object_key text, state text, created_at timestamptz,
  deleted_at timestamptz, object_removed_at timestamptz, unreferenced_since timestamptz)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH pinned AS (
    SELECT m.workspace_id, m.media_id FROM app.operation_media AS m
      JOIN app.operations AS o ON o.workspace_id = m.workspace_id AND o.id = m.operation_id
      WHERE (media_unused.workspaces IS NULL OR m.workspace_id = ANY (media_unused.workspaces))
        AND (media_unused.only_asset IS NULL OR m.media_id = media_unused.only_asset)
        AND (o.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')
          OR (o.state = 'superseded_after_unknown_outcome'
            AND (o.unverified_until IS NULL OR o.unverified_until > clock_timestamp())))
  )
  SELECT a.workspace_id, a.id, a.object_key, a.state, a.created_at, a.deleted_at, a.object_removed_at,
      a.unreferenced_since
    FROM app.media_assets AS a
    WHERE (media_unused.workspaces IS NULL OR a.workspace_id = ANY (media_unused.workspaces))
      AND (media_unused.only_asset IS NULL OR a.id = media_unused.only_asset)
      AND NOT a.in_library
      AND NOT EXISTS (SELECT 1 FROM app.post_media AS pm WHERE pm.workspace_id = a.workspace_id AND pm.media_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM pinned AS p WHERE p.workspace_id = a.workspace_id AND p.media_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM app.workspaces AS w WHERE w.id = a.workspace_id AND w.avatar = a.id)
$$;

-- The one rule for the candidate list and the take.
CREATE OR REPLACE FUNCTION app.media_gc_due(workspaces uuid[], only_asset uuid)
RETURNS TABLE (workspace_id uuid, asset_id uuid, object_key text, arm text)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.workspace_id, a.id, a.object_key, 'pending_upload'::text
    FROM app.media_assets AS a
    WHERE (media_gc_due.workspaces IS NULL OR a.workspace_id = ANY (media_gc_due.workspaces))
      AND (media_gc_due.only_asset IS NULL OR a.id = media_gc_due.only_asset)
      AND a.state = 'pending_upload' AND a.created_at <= clock_timestamp() - interval '24 hours'
  UNION ALL
  SELECT u.workspace_id, u.asset_id, u.object_key,
      CASE u.state WHEN 'ready' THEN 'unreferenced' ELSE u.state END
    FROM app.media_unused(media_gc_due.workspaces, media_gc_due.only_asset) AS u
    WHERE (u.state = 'rejected' AND u.created_at <= clock_timestamp() - interval '30 days')
      OR (u.state = 'ready' AND u.unreferenced_since <= clock_timestamp() - interval '30 days')
      OR (u.state = 'deleted' AND u.object_removed_at IS NULL
        AND u.deleted_at <= clock_timestamp() - interval '30 days')
$$;

-- Starts the clock of each ready asset nothing needs and clears it on each one that is needed again, at most `lim` rows
-- a call, so the caller repeats it until it answers fewer. A row a save holds is skipped and seen by the next call or
-- run; a save clears what it names itself.
CREATE FUNCTION app.media_mark_unreferenced(lim integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  ws uuid[];
  changed integer;
BEGIN
  IF app.principal_kind() IS DISTINCT FROM 'job' THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  IF media_mark_unreferenced.lim IS NULL OR media_mark_unreferenced.lim NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'media_mark_unreferenced: the limit is 1 to 500' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'media_mark_unreferenced', true);
  ws := CASE WHEN cardinality(app.ws_ids()) = 0 THEN NULL ELSE app.ws_ids() END;
  WITH unused AS (
    SELECT u.workspace_id, u.asset_id FROM app.media_unused(ws, NULL) AS u WHERE u.state = 'ready'
  ), due AS (
    SELECT a.workspace_id, a.id, a.unreferenced_since IS NULL AS starts FROM app.media_assets AS a
      WHERE (ws IS NULL OR a.workspace_id = ANY (ws)) AND a.state = 'ready'
        AND (a.unreferenced_since IS NULL) = EXISTS (
          SELECT 1 FROM unused AS u WHERE u.workspace_id = a.workspace_id AND u.asset_id = a.id)
      ORDER BY a.id LIMIT media_mark_unreferenced.lim
      FOR UPDATE OF a SKIP LOCKED
  )
  UPDATE app.media_assets AS a SET unreferenced_since = CASE WHEN d.starts THEN clock_timestamp() END
    FROM due AS d WHERE a.workspace_id = d.workspace_id AND a.id = d.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN changed;
END
$$;

-- Not an entry point: no runtime role may run it. The caller already holds the post row; locking it again here keeps
-- the lock order visible in this body. Existing variants are locked by ascending id before any is written, and a
-- variant the draft leaves unchanged is not written. The media the draft names are then locked by ascending id, so
-- two saves naming the same media wait for each other instead of deadlocking, and each named medium loses its clock.
CREATE OR REPLACE FUNCTION app.post_apply_draft(workspace_id uuid, post_id uuid, draft jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  r record;
  vid uuid;
  gone uuid;
  kept uuid[] := '{}';
  freed uuid[] := '{}';
  named uuid[];
BEGIN
  IF jsonb_typeof(post_apply_draft.draft) IS DISTINCT FROM 'object'
     OR jsonb_typeof(post_apply_draft.draft -> 'variants') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'post: the snapshot needs a draft object with a variants array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(post_apply_draft.draft -> 'variants') > 100 THEN
    RAISE EXCEPTION 'post: a draft holds at most 100 variants' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM app.posts AS p
    WHERE p.workspace_id = post_apply_draft.workspace_id AND p.id = post_apply_draft.post_id FOR UPDATE;
  PERFORM 1 FROM app.post_variants AS v
    WHERE v.workspace_id = post_apply_draft.workspace_id AND v.post_id = post_apply_draft.post_id ORDER BY v.id FOR UPDATE;
  SELECT coalesce(array_agg(DISTINCT (m.value ->> 'media_id')::uuid), '{}') INTO named
    FROM jsonb_array_elements(post_apply_draft.draft -> 'variants') AS e (value),
      jsonb_array_elements(CASE jsonb_typeof(e.value -> 'media') WHEN 'array' THEN e.value -> 'media' ELSE '[]' END)
        AS m (value);
  PERFORM set_config('app.job_purpose', 'post_apply_draft', true);
  PERFORM 1 FROM app.media_assets AS a
    WHERE a.workspace_id = post_apply_draft.workspace_id AND a.id = ANY (named) ORDER BY a.id FOR UPDATE;
  UPDATE app.media_assets AS a SET unreferenced_since = NULL
    WHERE a.workspace_id = post_apply_draft.workspace_id AND a.id = ANY (named) AND a.unreferenced_since IS NOT NULL;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  FOR r IN
    SELECT e.value AS element, x.* FROM jsonb_array_elements(post_apply_draft.draft -> 'variants') AS e (value),
      jsonb_to_record(e.value) AS x (channel_id uuid, locale text, post_type text, "text" text, parts jsonb,
        settings jsonb, media jsonb)
  LOOP
    SELECT v.id INTO vid FROM app.post_variants AS v
      WHERE v.workspace_id = post_apply_draft.workspace_id AND v.post_id = post_apply_draft.post_id
        AND v.channel_id = r.channel_id AND v.locale IS NOT DISTINCT FROM r.locale;
    IF vid IS NOT NULL AND vid = ANY (kept) THEN
      RAISE EXCEPTION 'post: two variants of one channel and locale' USING ERRCODE = '23505';
    ELSIF vid IS NOT NULL AND app.post_variant_body(r.element)
        IS NOT DISTINCT FROM app.post_variant_stored(post_apply_draft.workspace_id, vid) THEN
      kept := kept || vid;
      vid := NULL;
      CONTINUE;
    ELSIF vid IS NOT NULL THEN
      IF app.post_guard_variant(post_apply_draft.workspace_id, vid, false) THEN
        freed := freed || vid;
      END IF;
      UPDATE app.post_variants SET post_type = coalesce(r.post_type, 'text'), "text" = coalesce(r."text", ''),
        parts = coalesce(r.parts, '[]'), settings = coalesce(r.settings, '{}'), updated_at = clock_timestamp()
        WHERE id = vid;
    ELSE
      INSERT INTO app.post_variants (workspace_id, post_id, channel_id, locale, post_type, "text", parts, settings)
        VALUES (post_apply_draft.workspace_id, post_apply_draft.post_id, r.channel_id, r.locale,
          coalesce(r.post_type, 'text'), coalesce(r."text", ''), coalesce(r.parts, '[]'), coalesce(r.settings, '{}'))
        RETURNING id INTO vid;
    END IF;
    kept := kept || vid;
    DELETE FROM app.post_media AS m WHERE m.workspace_id = post_apply_draft.workspace_id AND m.variant_id = vid;
    INSERT INTO app.post_media (workspace_id, variant_id, position, media_id, alt_text, crop)
      SELECT post_apply_draft.workspace_id, vid, (m.ord - 1)::integer, (m.value ->> 'media_id')::uuid,
        m.value ->> 'alt_text', m.value -> 'crop'
      FROM jsonb_array_elements(coalesce(r.media, '[]')) WITH ORDINALITY AS m (value, ord);
    vid := NULL;
  END LOOP;
  FOR gone IN SELECT v.id FROM app.post_variants AS v
    WHERE v.workspace_id = post_apply_draft.workspace_id AND v.post_id = post_apply_draft.post_id AND v.id <> ALL (kept)
    ORDER BY v.id
  LOOP
    PERFORM app.post_guard_variant(post_apply_draft.workspace_id, gone, true);
  END LOOP;
  DELETE FROM app.post_variants AS v
    WHERE v.workspace_id = post_apply_draft.workspace_id AND v.post_id = post_apply_draft.post_id AND v.id <> ALL (kept);
  FOREACH gone IN ARRAY freed LOOP
    PERFORM app.ledger_rollup(post_apply_draft.workspace_id, gone, NULL);
  END LOOP;
END
$$;

-- A medium put in the library is in use, so it loses its clock.
CREATE OR REPLACE FUNCTION app.media_set_metadata(
  workspace_id uuid, asset_id uuid, file_name text, tags text[], in_library boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'media_set_metadata', true);
  PERFORM app.media_caller(media_set_metadata.workspace_id, 3, false);
  PERFORM 1 FROM app.media_assets AS a
    WHERE a.workspace_id = media_set_metadata.workspace_id AND a.id = media_set_metadata.asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  UPDATE app.media_assets AS a SET file_name = coalesce(media_set_metadata.file_name, a.file_name),
      tags = coalesce(media_set_metadata.tags, a.tags), in_library = coalesce(media_set_metadata.in_library, a.in_library),
      unreferenced_since = CASE WHEN media_set_metadata.in_library THEN NULL ELSE a.unreferenced_since END
    WHERE a.workspace_id = media_set_metadata.workspace_id AND a.id = media_set_metadata.asset_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.media_unused(uuid[], uuid), app.media_mark_unreferenced(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_mark_unreferenced(integer) TO shoutory_worker;
RESET ROLE;

CALL app.grant_purposes('media_assets', 'SELECT', ARRAY['media_mark_unreferenced', 'post_apply_draft']);
CALL app.grant_purposes('media_assets', 'UPDATE', ARRAY['media_mark_unreferenced', 'post_apply_draft']);
CALL app.grant_purposes('operations', 'SELECT', ARRAY['media_mark_unreferenced']);
CALL app.grant_purposes('operation_media', 'SELECT', ARRAY['media_mark_unreferenced']);
CALL app.grant_purposes('post_media', 'SELECT', ARRAY['media_mark_unreferenced']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['media_mark_unreferenced']);
