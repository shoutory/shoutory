-- Editing and deleting a published post. Each is one definer that locks the post first, then its targets in id order,
-- then makes the operation through the same helper admission uses. An edit writes the new version and the new content of
-- the changed targets; a delete starts at the highest published part, and the later parts of a thread follow through
-- admission. A target that has an operation in flight is refused, and so is an edit after the provider's edit window.
-- The provider facts come from the caller as one object, as they do for admission.

-- The definer creates the trigger, so it holds TRIGGER on the table until the trigger exists.
GRANT TRIGGER ON app.operations TO shoutory_definer;
SET ROLE shoutory_definer;

-- A person's resolution that sends again, and a person's insert, is claimed before the backlog of its provider's queue.
CREATE FUNCTION app.operations_priority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.last_actor = 'U' AND NEW.state IN ('retry_wait', 'pending')
     AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state) THEN
    NEW.priority := true;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.operations_priority() FROM PUBLIC;
CREATE TRIGGER operations_c_priority BEFORE INSERT OR UPDATE ON app.operations
  FOR EACH ROW EXECUTE FUNCTION app.operations_priority();

CREATE FUNCTION app.post_edit(
  workspace_id uuid, post_id uuid, expected_version uuid, snapshot jsonb, snapshot_hash bytea, providers jsonb,
  request_id text, ip_hmac bytea)
RETURNS TABLE (outcome text, version_id uuid, operation_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  current_id uuid;
  post_status text;
  new_version constant uuid := uuidv7();
  who constant uuid := app.principal_id();
  r record;
  secs integer;
  window_secs integer;
  made uuid;
  matched integer := 0;
BEGIN
  PERFORM set_config('app.job_purpose', 'post_edit', true);
  PERFORM app.media_caller(post_edit.workspace_id, 3, false);
  IF jsonb_typeof(post_edit.providers) IS DISTINCT FROM 'object'
     OR jsonb_typeof(post_edit.snapshot -> 'draft' -> 'variants') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'post: the edit needs a draft with variants and the provider facts' USING ERRCODE = '22023';
  END IF;
  SELECT p.current_version_id, p.status INTO current_id, post_status FROM app.posts AS p
    WHERE p.workspace_id = post_edit.workspace_id AND p.id = post_edit.post_id AND p.deleted_at IS NULL
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post: refused' USING ERRCODE = '42501';
  END IF;
  IF current_id IS DISTINCT FROM post_edit.expected_version THEN
    outcome := 'stale'; version_id := current_id; operation_ids := '{}';
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN NEXT;
    RETURN;
  END IF;
  IF post_status = 'archived' THEN
    RAISE EXCEPTION 'post: post_archived' USING ERRCODE = 'SH409';
  END IF;
  PERFORM 1 FROM app.post_variants AS v WHERE v.workspace_id = post_edit.workspace_id AND v.post_id = post_edit.post_id
    ORDER BY v.id FOR NO KEY UPDATE;
  INSERT INTO app.post_versions (id, workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
    SELECT new_version, post_edit.workspace_id, post_edit.post_id, coalesce(max(v.version_no), 0) + 1, 'save',
      post_edit.snapshot, post_edit.snapshot_hash, who
    FROM app.post_versions AS v WHERE v.workspace_id = post_edit.workspace_id AND v.post_id = post_edit.post_id;
  outcome := 'ok'; version_id := new_version; operation_ids := '{}';
  FOR r IN
    SELECT v.id, v.channel_id, c.provider_id, v.published_at, v.schedule_state, e.value AS element,
        EXISTS (SELECT 1 FROM app.operations AS o WHERE o.workspace_id = v.workspace_id AND o.variant_id = v.id
          AND o.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome')) AS busy,
        app.post_variant_body(e.value) IS DISTINCT FROM app.post_variant_stored(v.workspace_id, v.id) AS changed
      FROM jsonb_array_elements(post_edit.snapshot -> 'draft' -> 'variants') AS e (value)
      JOIN app.post_variants AS v ON v.workspace_id = post_edit.workspace_id AND v.post_id = post_edit.post_id
        AND v.channel_id = (e.value ->> 'channel_id')::uuid AND v.locale IS NOT DISTINCT FROM (e.value ->> 'locale')
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      ORDER BY v.id
  LOOP
    matched := matched + 1;
    IF r.busy OR r.schedule_state IN ('held', 'in_progress') THEN
      RAISE EXCEPTION 'post: post_in_flight' USING ERRCODE = 'SH409';
    ELSIF r.published_at IS NULL THEN
      RAISE EXCEPTION 'post: not_published' USING ERRCODE = 'SH409';
    END IF;
    secs := (post_edit.providers -> r.provider_id -> 'lease_seconds' ->> 'edit')::integer;
    IF secs IS NULL THEN
      RAISE EXCEPTION 'post: capability_missing' USING ERRCODE = 'SH422';
    END IF;
    window_secs := (post_edit.providers -> r.provider_id ->> 'edit_window_seconds')::integer;
    IF window_secs IS NOT NULL AND clock_timestamp() > r.published_at + make_interval(secs => window_secs) THEN
      RAISE EXCEPTION 'post: edit_window_closed' USING ERRCODE = 'SH409';
    END IF;
    IF NOT r.changed THEN
      CONTINUE;
    END IF;
    UPDATE app.post_variants AS v SET post_type = coalesce(r.element ->> 'post_type', 'text'),
        "text" = coalesce(r.element ->> 'text', ''), parts = coalesce(nullif(r.element -> 'parts', 'null'), '[]'),
        settings = coalesce(nullif(r.element -> 'settings', 'null'), '{}'), updated_at = clock_timestamp()
      WHERE v.workspace_id = post_edit.workspace_id AND v.id = r.id;
    DELETE FROM app.post_media AS m WHERE m.workspace_id = post_edit.workspace_id AND m.variant_id = r.id;
    INSERT INTO app.post_media (workspace_id, variant_id, position, media_id, alt_text, crop)
      SELECT post_edit.workspace_id, r.id, (m.ord - 1)::integer, (m.value ->> 'media_id')::uuid, m.value ->> 'alt_text',
        m.value -> 'crop'
      FROM jsonb_array_elements(coalesce(nullif(r.element -> 'media', 'null'), '[]')) WITH ORDINALITY AS m (value, ord);
    SELECT f.new_operation INTO made FROM app.ledger_admit_target(post_edit.workspace_id, r.id, r.channel_id,
      r.provider_id, 'edit', 0, NULL, clock_timestamp(), false, who, secs, new_version, 'edit-' || uuidv7()::text,
      true, false, 'post.edit_requested', post_edit.request_id, post_edit.ip_hmac) AS f;
    operation_ids := operation_ids || made;
  END LOOP;
  IF matched <> jsonb_array_length(post_edit.snapshot -> 'draft' -> 'variants') THEN
    RAISE EXCEPTION 'post: the draft names a target the post does not have' USING ERRCODE = '22023';
  END IF;
  IF cardinality(operation_ids) = 0 THEN
    RAISE EXCEPTION 'post: the draft changes nothing' USING ERRCODE = '22023';
  END IF;
  UPDATE app.posts AS p SET current_version_id = new_version, updated_at = clock_timestamp()
    WHERE p.workspace_id = post_edit.workspace_id AND p.id = post_edit.post_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN NEXT;
END
$$;

CREATE FUNCTION app.post_delete(
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

REVOKE ALL ON FUNCTION app.post_edit(uuid, uuid, uuid, jsonb, bytea, jsonb, text, bytea),
  app.post_delete(uuid, uuid, uuid, uuid[], jsonb, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.post_edit(uuid, uuid, uuid, jsonb, bytea, jsonb, text, bytea),
  app.post_delete(uuid, uuid, uuid, uuid[], jsonb, text, bytea) TO shoutory_app;

RESET ROLE;
REVOKE TRIGGER ON app.operations FROM shoutory_definer;
