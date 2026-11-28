-- A schedule refuses a due time that is not ahead, and refuses when the post's current version is not the one the caller
-- checked. Publish now is due at the moment it runs, so it is exempt from the first rule only.
SET ROLE shoutory_definer;

DROP FUNCTION app.post_publish_now(uuid, uuid, uuid[]);
DROP FUNCTION app.post_schedule(uuid, uuid, uuid[], timestamp, text, timestamptz, boolean);

CREATE FUNCTION app.post_schedule(
  workspace_id uuid, post_id uuid, variant_ids uuid[], local_due timestamp, due_tz text, due_at timestamptz,
  publish_now boolean, expected_version uuid)
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  current_version uuid;
  post_status text;
  picked uuid[];
  r record;
BEGIN
  PERFORM set_config('app.job_purpose', 'post_schedule', true);
  PERFORM app.media_caller(post_schedule.workspace_id, 3, false);
  SELECT p.current_version_id, p.status INTO current_version, post_status FROM app.posts AS p
    WHERE p.workspace_id = post_schedule.workspace_id AND p.id = post_schedule.post_id AND p.deleted_at IS NULL
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post: refused' USING ERRCODE = '42501';
  END IF;
  IF post_status = 'archived' THEN
    RAISE EXCEPTION 'post: post_archived' USING ERRCODE = 'SH409';
  END IF;
  IF current_version IS DISTINCT FROM post_schedule.expected_version THEN
    RAISE EXCEPTION 'post: version_changed' USING ERRCODE = 'SH409';
  END IF;
  IF NOT coalesce(post_schedule.publish_now, false) AND post_schedule.due_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'post: in_the_past' USING ERRCODE = 'SH422';
  END IF;
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}') INTO picked FROM app.post_variants AS v
    WHERE v.workspace_id = post_schedule.workspace_id AND v.post_id = post_schedule.post_id
      AND (post_schedule.variant_ids IS NULL OR v.id = ANY (post_schedule.variant_ids));
  IF cardinality(picked) = 0 OR (post_schedule.variant_ids IS NOT NULL
      AND cardinality(picked) <> (SELECT count(DISTINCT x) FROM unnest(post_schedule.variant_ids) AS x)) THEN
    RAISE EXCEPTION 'post: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM app.post_variants AS v WHERE v.workspace_id = post_schedule.workspace_id AND v.id = ANY (picked)
    ORDER BY v.id FOR NO KEY UPDATE;
  FOR r IN
    SELECT v.id, v.schedule_state, v.published_at, c.connection_state,
        EXISTS (SELECT 1 FROM app.operations AS o WHERE o.workspace_id = v.workspace_id AND o.variant_id = v.id
          AND o.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')) AS busy
      FROM app.post_variants AS v
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      WHERE v.workspace_id = post_schedule.workspace_id AND v.id = ANY (picked) ORDER BY v.id
  LOOP
    IF r.busy OR r.schedule_state IN ('held', 'in_progress') THEN
      RAISE EXCEPTION 'post: post_in_flight' USING ERRCODE = 'SH409';
    ELSIF r.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'post: use_edit' USING ERRCODE = 'SH409';
    ELSIF r.connection_state NOT IN ('connected', 'disabled') THEN
      RAISE EXCEPTION 'post: channel_not_connected' USING ERRCODE = 'SH409';
    END IF;
  END LOOP;
  UPDATE app.post_versions AS f SET kind = 'scheduled'
    WHERE f.workspace_id = post_schedule.workspace_id AND f.id = current_version AND f.kind IN ('autosave', 'save');
  UPDATE app.post_variants AS v SET schedule_state = 'scheduled', frozen_version_id = current_version,
      local_due = post_schedule.local_due, due_tz = post_schedule.due_tz, due_at = post_schedule.due_at,
      publish_now = coalesce(post_schedule.publish_now, false), admit_skip_until = NULL, updated_at = clock_timestamp()
    WHERE v.workspace_id = post_schedule.workspace_id AND v.id = ANY (picked);
  UPDATE app.posts AS p SET status = 'scheduled', updated_at = clock_timestamp()
    WHERE p.workspace_id = post_schedule.workspace_id AND p.id = post_schedule.post_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN picked;
END
$$;

CREATE FUNCTION app.post_publish_now(workspace_id uuid, post_id uuid, variant_ids uuid[], expected_version uuid)
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  zone text;
  picked uuid[];
  moment constant timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('app.job_purpose', 'post_schedule', true);
  SELECT w.default_tz INTO zone FROM app.workspaces AS w WHERE w.id = post_publish_now.workspace_id;
  picked := app.post_schedule(post_publish_now.workspace_id, post_publish_now.post_id, post_publish_now.variant_ids,
    (moment AT TIME ZONE coalesce(zone, 'UTC'))::timestamp, coalesce(zone, 'UTC'), moment, true,
    post_publish_now.expected_version);
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN picked;
END
$$;

REVOKE ALL ON FUNCTION app.post_schedule(uuid, uuid, uuid[], timestamp, text, timestamptz, boolean, uuid),
  app.post_publish_now(uuid, uuid, uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.post_schedule(uuid, uuid, uuid[], timestamp, text, timestamptz, boolean, uuid),
  app.post_publish_now(uuid, uuid, uuid[], uuid) TO shoutory_app;

RESET ROLE;
