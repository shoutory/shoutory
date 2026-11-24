-- A write changes a variant only where its state allows it: a running or published variant is refused with a reason, a
-- scheduled or approved one keeps the version it was frozen on until it is scheduled again, and a settled one that
-- never published goes back to draft.
CALL app.grant_purposes('operations', 'SELECT', ARRAY['post_autosave', 'post_save', 'post_restore']);
GRANT UPDATE (frozen_version_id) ON app.post_variants TO shoutory_definer;

SET ROLE shoutory_definer;

-- One variant of a draft in the one form that a stored variant and a recorded one are compared in.
CREATE FUNCTION app.post_variant_body(element jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object('post_type', coalesce(element ->> 'post_type', 'text'),
    'text', coalesce(element ->> 'text', ''), 'parts', coalesce(nullif(element -> 'parts', 'null'), '[]'),
    'settings', coalesce(nullif(element -> 'settings', 'null'), '{}'),
    'media', coalesce((SELECT jsonb_agg(jsonb_build_object('media_id', (m.value ->> 'media_id')::uuid,
        'alt_text', m.value ->> 'alt_text', 'crop', m.value -> 'crop') ORDER BY m.ord)
      FROM jsonb_array_elements(coalesce(nullif(element -> 'media', 'null'), '[]')) WITH ORDINALITY AS m (value, ord)), '[]'))
$$;

CREATE FUNCTION app.post_variant_stored(workspace_id uuid, variant_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT app.post_variant_body(jsonb_build_object('post_type', v.post_type, 'text', v."text", 'parts', v.parts,
    'settings', v.settings, 'media', coalesce((SELECT jsonb_agg(jsonb_build_object('media_id', m.media_id,
        'alt_text', m.alt_text, 'crop', m.crop) ORDER BY m.position)
      FROM app.post_media AS m WHERE m.workspace_id = v.workspace_id AND m.variant_id = v.id), '[]')))
  FROM app.post_variants AS v
  WHERE v.workspace_id = post_variant_stored.workspace_id AND v.id = post_variant_stored.variant_id
$$;

-- Called with the variant row locked, before a change to it or its removal is written. True when the variant was
-- settled without publishing: it is unfrozen here and set back to draft by the rollup once the draft is written.
CREATE FUNCTION app.post_guard_variant(workspace_id uuid, variant_id uuid, dropped boolean)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  state text;
  sent timestamptz;
BEGIN
  SELECT v.schedule_state, v.published_at INTO state, sent FROM app.post_variants AS v
    WHERE v.workspace_id = post_guard_variant.workspace_id AND v.id = post_guard_variant.variant_id;
  IF state IN ('held', 'in_progress') OR EXISTS (SELECT 1 FROM app.operations AS o
      WHERE o.workspace_id = post_guard_variant.workspace_id AND o.variant_id = post_guard_variant.variant_id
        AND o.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')) THEN
    RAISE EXCEPTION 'post: post_in_flight' USING ERRCODE = 'SH409';
  END IF;
  IF dropped AND EXISTS (SELECT 1 FROM app.operations AS o
      WHERE o.workspace_id = post_guard_variant.workspace_id AND o.variant_id = post_guard_variant.variant_id) THEN
    RAISE EXCEPTION 'post: variant_has_history' USING ERRCODE = 'SH409';
  END IF;
  IF sent IS NOT NULL OR EXISTS (SELECT 1 FROM app.operations AS o
      WHERE o.workspace_id = post_guard_variant.workspace_id AND o.variant_id = post_guard_variant.variant_id
        AND o.kind = 'publish' AND o.state = 'published') THEN
    RAISE EXCEPTION 'post: use_edit' USING ERRCODE = 'SH409';
  END IF;
  IF state <> 'settled' OR dropped THEN
    RETURN false;
  END IF;
  UPDATE app.post_variants AS v SET frozen_version_id = NULL
    WHERE v.workspace_id = post_guard_variant.workspace_id AND v.id = post_guard_variant.variant_id;
  RETURN true;
END
$$;

-- Not an entry point: no runtime role may run it. The caller holds the post row lock; the existing variants are locked
-- by ascending id before any is written. A variant whose content the draft leaves as it is, is not written.
CREATE OR REPLACE FUNCTION app.post_apply_draft(workspace_id uuid, post_id uuid, draft jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r record;
  vid uuid;
  gone uuid;
  kept uuid[] := '{}';
  freed uuid[] := '{}';
BEGIN
  IF jsonb_typeof(post_apply_draft.draft) IS DISTINCT FROM 'object'
     OR jsonb_typeof(post_apply_draft.draft -> 'variants') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'post: the snapshot needs a draft object with a variants array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(post_apply_draft.draft -> 'variants') > 100 THEN
    RAISE EXCEPTION 'post: a draft holds at most 100 variants' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM app.post_variants AS v
    WHERE v.workspace_id = post_apply_draft.workspace_id AND v.post_id = post_apply_draft.post_id ORDER BY v.id FOR UPDATE;
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

DROP FUNCTION app.post_autosave(uuid, uuid, uuid, jsonb, bytea);
DROP FUNCTION app.post_save(uuid, uuid, uuid, jsonb, bytea);
DROP FUNCTION app.post_restore(uuid, uuid, uuid, uuid);
DROP FUNCTION app.post_write_version(uuid, uuid, uuid, jsonb, bytea, text);

-- Not an entry point: no runtime EXECUTE. The post row lock orders concurrent writers. A stale expected version
-- changes nothing and returns the current version; it is checked before any refusal. An unknown, deleted or foreign
-- post is refused like any other foreign row. The pending variants are the frozen ones whose content now differs from
-- the version they were frozen on.
CREATE FUNCTION app.post_write_version(
  workspace_id uuid, post_id uuid, expected_version uuid, snapshot jsonb, snapshot_hash bytea, kind text)
RETURNS TABLE (outcome text, version_id uuid, pending_changes uuid[])
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_id uuid;
  status text;
  new_version constant uuid := uuidv7();
BEGIN
  SELECT p.current_version_id, p.status INTO current_id, status FROM app.posts AS p
    WHERE p.id = post_write_version.post_id AND p.workspace_id = post_write_version.workspace_id
      AND p.deleted_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post: refused' USING ERRCODE = '42501';
  END IF;
  IF current_id IS DISTINCT FROM post_write_version.expected_version THEN
    outcome := 'stale';
    version_id := current_id;
    pending_changes := '{}';
    RETURN NEXT;
    RETURN;
  END IF;
  IF status = 'archived' THEN
    RAISE EXCEPTION 'post: post_archived' USING ERRCODE = 'SH409';
  END IF;
  INSERT INTO app.post_versions (id, workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
    SELECT new_version, post_write_version.workspace_id, post_write_version.post_id,
      coalesce(max(v.version_no), 0) + 1, post_write_version.kind, post_write_version.snapshot,
      post_write_version.snapshot_hash, app.principal_id()
    FROM app.post_versions AS v
    WHERE v.workspace_id = post_write_version.workspace_id AND v.post_id = post_write_version.post_id;
  PERFORM app.post_apply_draft(post_write_version.workspace_id, post_write_version.post_id,
    post_write_version.snapshot -> 'draft');
  UPDATE app.posts AS p SET current_version_id = new_version, updated_at = clock_timestamp()
    WHERE p.id = post_write_version.post_id;
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}') INTO pending_changes FROM app.post_variants AS v
    WHERE v.workspace_id = post_write_version.workspace_id AND v.post_id = post_write_version.post_id
      AND v.schedule_state IN ('needs_approval', 'approved', 'scheduled')
      AND app.post_variant_stored(v.workspace_id, v.id) IS DISTINCT FROM (
        SELECT app.post_variant_body(e.value) FROM app.post_versions AS f,
          jsonb_array_elements(f.snapshot -> 'draft' -> 'variants') AS e (value)
        WHERE f.workspace_id = v.workspace_id AND f.id = v.frozen_version_id
          AND (e.value ->> 'channel_id')::uuid = v.channel_id AND e.value ->> 'locale' IS NOT DISTINCT FROM v.locale
        LIMIT 1);
  outcome := 'ok';
  version_id := new_version;
  RETURN NEXT;
END
$$;

CREATE FUNCTION app.post_autosave(
  workspace_id uuid, post_id uuid, expected_version uuid, snapshot jsonb, snapshot_hash bytea)
RETURNS TABLE (outcome text, version_id uuid, pending_changes uuid[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'post_autosave', true);
  PERFORM app.media_caller(post_autosave.workspace_id, 3, false);
  RETURN QUERY SELECT w.outcome, w.version_id, w.pending_changes FROM app.post_write_version(
    post_autosave.workspace_id, post_autosave.post_id, post_autosave.expected_version, post_autosave.snapshot,
    post_autosave.snapshot_hash, 'autosave') AS w;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

CREATE FUNCTION app.post_save(
  workspace_id uuid, post_id uuid, expected_version uuid, snapshot jsonb, snapshot_hash bytea)
RETURNS TABLE (outcome text, version_id uuid, pending_changes uuid[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'post_save', true);
  PERFORM app.media_caller(post_save.workspace_id, 3, false);
  RETURN QUERY SELECT w.outcome, w.version_id, w.pending_changes FROM app.post_write_version(post_save.workspace_id,
    post_save.post_id, post_save.expected_version, post_save.snapshot, post_save.snapshot_hash, 'save') AS w;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- A source that is not a version of this post is refused like an unknown post.
CREATE FUNCTION app.post_restore(workspace_id uuid, post_id uuid, expected_version uuid, source_version uuid)
RETURNS TABLE (outcome text, version_id uuid, pending_changes uuid[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  old record;
BEGIN
  PERFORM set_config('app.job_purpose', 'post_restore', true);
  PERFORM app.media_caller(post_restore.workspace_id, 3, false);
  -- Versions never change, so the source is read before the post is locked.
  SELECT v.snapshot, v.snapshot_hash INTO old FROM app.post_versions AS v
    WHERE v.id = post_restore.source_version AND v.workspace_id = post_restore.workspace_id
      AND v.post_id = post_restore.post_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post: refused' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT w.outcome, w.version_id, w.pending_changes FROM app.post_write_version(
    post_restore.workspace_id, post_restore.post_id, post_restore.expected_version, old.snapshot, old.snapshot_hash,
    'save') AS w;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.post_variant_body(jsonb), app.post_variant_stored(uuid, uuid),
  app.post_guard_variant(uuid, uuid, boolean), app.post_write_version(uuid, uuid, uuid, jsonb, bytea, text),
  app.post_autosave(uuid, uuid, uuid, jsonb, bytea), app.post_save(uuid, uuid, uuid, jsonb, bytea),
  app.post_restore(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.post_autosave(uuid, uuid, uuid, jsonb, bytea), app.post_save(uuid, uuid, uuid, jsonb, bytea),
  app.post_restore(uuid, uuid, uuid, uuid) TO shoutory_app;
RESET ROLE;
