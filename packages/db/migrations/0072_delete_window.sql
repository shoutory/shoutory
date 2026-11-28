-- A provider that declares a window for deleting a post (the facts the caller passes) refuses the delete once the
-- window has passed, before any operation is made; the edit window is refused the same way.
SET ROLE shoutory_definer;

CREATE OR REPLACE FUNCTION app.post_delete(
  workspace_id uuid, post_id uuid, expected_version uuid, variant_ids uuid[], providers jsonb, request_id text,
  ip_hmac bytea)
RETURNS TABLE (outcome text, version_id uuid, operation_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  current_id uuid;
  who constant uuid := app.principal_id();
  picked uuid[];
  r record;
  top record;
  secs integer;
  window_secs integer;
  made uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'post_delete', true);
  PERFORM app.media_caller(post_delete.workspace_id, 3, false);
  IF jsonb_typeof(post_delete.providers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'post: the delete needs the provider facts' USING ERRCODE = '22023';
  END IF;
  SELECT p.current_version_id INTO current_id FROM app.posts AS p
    WHERE p.workspace_id = post_delete.workspace_id AND p.id = post_delete.post_id AND p.deleted_at IS NULL
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post: refused' USING ERRCODE = '42501';
  END IF;
  outcome := 'ok'; version_id := current_id; operation_ids := '{}';
  IF current_id IS DISTINCT FROM post_delete.expected_version THEN
    outcome := 'stale';
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}') INTO picked FROM app.post_variants AS v
    WHERE v.workspace_id = post_delete.workspace_id AND v.post_id = post_delete.post_id
      AND (v.id = ANY (post_delete.variant_ids) OR (post_delete.variant_ids IS NULL AND (v.published_at IS NOT NULL
        OR v.schedule_state IN ('held', 'in_progress'))));
  IF post_delete.variant_ids IS NOT NULL AND cardinality(picked) <> (SELECT count(DISTINCT x) FROM unnest(post_delete.variant_ids) AS x) THEN
    RAISE EXCEPTION 'post: refused' USING ERRCODE = '42501';
  ELSIF cardinality(picked) = 0 THEN
    RAISE EXCEPTION 'post: not_published' USING ERRCODE = 'SH409';
  END IF;
  PERFORM 1 FROM app.post_variants AS v WHERE v.workspace_id = post_delete.workspace_id AND v.id = ANY (picked)
    ORDER BY v.id FOR NO KEY UPDATE;
  FOR r IN
    SELECT v.id, v.channel_id, c.provider_id, v.published_at, v.schedule_state, v.presence,
        EXISTS (SELECT 1 FROM app.operations AS o WHERE o.workspace_id = v.workspace_id AND o.variant_id = v.id
          AND o.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')) AS busy
      FROM app.post_variants AS v
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      WHERE v.workspace_id = post_delete.workspace_id AND v.id = ANY (picked) ORDER BY v.id
  LOOP
    IF r.busy OR r.schedule_state IN ('held', 'in_progress') THEN
      RAISE EXCEPTION 'post: post_in_flight' USING ERRCODE = 'SH409';
    ELSIF r.published_at IS NULL OR r.presence <> 'present' THEN
      RAISE EXCEPTION 'post: not_published' USING ERRCODE = 'SH409';
    END IF;
    secs := (post_delete.providers -> r.provider_id -> 'lease_seconds' ->> 'delete')::integer;
    IF secs IS NULL THEN
      RAISE EXCEPTION 'post: capability_missing' USING ERRCODE = 'SH422';
    END IF;
    window_secs := (post_delete.providers -> r.provider_id ->> 'delete_window_seconds')::integer;
    IF window_secs IS NOT NULL AND clock_timestamp() > r.published_at + make_interval(secs => window_secs) THEN
      RAISE EXCEPTION 'post: delete_window_closed' USING ERRCODE = 'SH409';
    END IF;
    SELECT o.part_index, o.frozen_version_id INTO top FROM app.operations AS o
      WHERE o.workspace_id = post_delete.workspace_id AND o.variant_id = r.id AND o.kind = 'publish'
        AND o.state = 'published'
      ORDER BY o.part_index DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'post: not_published' USING ERRCODE = 'SH409';
    END IF;
    SELECT f.new_operation INTO made FROM app.ledger_admit_target(post_delete.workspace_id, r.id, r.channel_id,
      r.provider_id, 'delete', top.part_index, NULL, clock_timestamp(), false, who, secs, top.frozen_version_id,
      'delete-' || uuidv7()::text || '-' || top.part_index, false, false, 'post.delete_requested',
      post_delete.request_id, post_delete.ip_hmac) AS f;
    operation_ids := operation_ids || made;
  END LOOP;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEXT;
END
$$;

RESET ROLE;
