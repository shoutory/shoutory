-- `current_version_id` is also the ETag of the post: an autosave that does not name it is stale.
CREATE TABLE app.posts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  author_kind text NOT NULL CHECK (author_kind IN ('user', 'service')),
  author_id uuid NOT NULL,
  origin text NOT NULL DEFAULT 'ui' CHECK (origin = 'ui'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'publishing', 'published',
    'partially_published', 'needs_attention', 'failed', 'missed', 'archived')),
  targets_total integer NOT NULL DEFAULT 0 CHECK (targets_total >= 0),
  targets_published integer NOT NULL DEFAULT 0 CHECK (targets_published >= 0),
  targets_published_not_live integer NOT NULL DEFAULT 0 CHECK (targets_published_not_live >= 0),
  current_version_id uuid,
  first_due_at timestamptz,
  published_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT posts_workspace_id_key UNIQUE (workspace_id, id)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX posts_status_idx ON app.posts (workspace_id, status, updated_at DESC);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX posts_published_idx ON app.posts (workspace_id, published_at DESC) WHERE published_at IS NOT NULL;
SELECT app.apply_rls_template('app.posts'::regclass, 'W');

CREATE TABLE app.post_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  post_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  kind text NOT NULL CHECK (kind IN ('autosave', 'save', 'submitted', 'scheduled', 'published')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 1048576),
  snapshot_hash bytea NOT NULL CHECK (octet_length(snapshot_hash) = 32),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT post_versions_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT post_versions_number_key UNIQUE (workspace_id, post_id, version_no),
  -- Lets the post and its variants name only a version of their own post.
  CONSTRAINT post_versions_post_key UNIQUE (workspace_id, post_id, id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES app.posts (workspace_id, id) ON DELETE CASCADE
);
SELECT app.apply_rls_template('app.post_versions'::regclass, 'A');

-- shoutory:accepted-lock new empty tables in this file
ALTER TABLE app.posts ADD CONSTRAINT posts_current_version_fkey
  FOREIGN KEY (workspace_id, id, current_version_id) REFERENCES app.post_versions (workspace_id, post_id, id);

-- The id is the publish target the ledger names, so a save keeps the id of a variant it matches by channel and locale.
CREATE TABLE app.post_variants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  post_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  locale text CHECK (char_length(locale) BETWEEN 2 AND 35),
  post_type text NOT NULL DEFAULT 'text' CHECK (post_type IN (
    'text', 'image', 'multi_image', 'video', 'document', 'article', 'reel', 'story', 'event', 'offer')),
  "text" text NOT NULL DEFAULT '' CHECK (char_length("text") <= 100000),
  parts jsonb NOT NULL DEFAULT '[]' CHECK (
    jsonb_typeof(parts) = 'array' AND jsonb_array_length(parts) <= 25 AND octet_length(parts::text) <= 262144),
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 65536),
  schedule_state text NOT NULL DEFAULT 'draft' CHECK (schedule_state IN (
    'draft', 'needs_approval', 'approved', 'scheduled', 'held', 'in_progress', 'settled')),
  local_due timestamp,
  due_tz text CHECK (char_length(due_tz) BETWEEN 1 AND 64),
  due_at timestamptz,
  frozen_version_id uuid,
  presence text NOT NULL DEFAULT 'present' CHECK (presence IN (
    'present', 'removal_pending', 'removal_unknown', 'removed_at_provider', 'removal_reported')),
  external_id text CHECK (char_length(external_id) <= 512),
  permalink text CHECK (char_length(permalink) <= 2048),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT post_variants_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT post_variants_target_key UNIQUE NULLS NOT DISTINCT (workspace_id, post_id, channel_id, locale),
  FOREIGN KEY (workspace_id, post_id) REFERENCES app.posts (workspace_id, id) ON DELETE CASCADE,
  -- Like every other child of a channel; operations that name a variant block a channel delete in their turn.
  FOREIGN KEY (workspace_id, channel_id) REFERENCES app.channels (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, post_id, frozen_version_id) REFERENCES app.post_versions (workspace_id, post_id, id)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX post_variants_admission_idx ON app.post_variants (due_at) WHERE schedule_state = 'scheduled';
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX post_variants_calendar_idx ON app.post_variants (workspace_id, due_at);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX post_variants_published_idx ON app.post_variants (workspace_id, published_at DESC)
  WHERE published_at IS NOT NULL;
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX post_variants_channel_idx ON app.post_variants (channel_id, schedule_state);
SELECT app.apply_rls_template('app.post_variants'::regclass, 'W');

CREATE TABLE app.post_media (
  workspace_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 31),
  media_id uuid NOT NULL,
  alt_text text CHECK (char_length(alt_text) <= 2000),
  crop jsonb CHECK (octet_length(crop::text) <= 1024),
  PRIMARY KEY (workspace_id, variant_id, position),
  FOREIGN KEY (workspace_id, variant_id) REFERENCES app.post_variants (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, media_id) REFERENCES app.media_assets (workspace_id, id) ON DELETE CASCADE
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX post_media_asset_idx ON app.post_media (workspace_id, media_id);
SELECT app.apply_rls_template('app.post_media'::regclass, 'W');

CREATE TABLE app.idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  principal_kind text NOT NULL CHECK (principal_kind IN ('user', 'service')),
  principal_id uuid NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  state text NOT NULL DEFAULT 'in_flight' CHECK (state IN ('in_flight', 'done')),
  in_flight_until timestamptz NOT NULL DEFAULT clock_timestamp() + interval '60 seconds',
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb CHECK (octet_length(response_body::text) <= 65536),
  resource_ids jsonb CHECK (octet_length(resource_ids::text) <= 4096),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  PRIMARY KEY (workspace_id, principal_kind, principal_id, key)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX idempotency_keys_expiry_idx ON app.idempotency_keys (expires_at);
SELECT app.apply_rls_template('app.idempotency_keys'::regclass, 'W');

-- The idempotency keys have no runtime grant at all.
GRANT SELECT ON app.posts, app.post_versions, app.post_variants, app.post_media TO shoutory_app, shoutory_worker;
GRANT SELECT, INSERT ON app.posts, app.post_versions TO shoutory_definer;
GRANT SELECT, INSERT, DELETE ON app.post_variants, app.post_media TO shoutory_definer;
GRANT SELECT, DELETE ON app.idempotency_keys TO shoutory_definer;
-- Not the workspace, the post, the channel or the author of a row; a version is never updated.
GRANT UPDATE (current_version_id, updated_at) ON app.posts TO shoutory_definer;
GRANT UPDATE ("text", post_type, parts, settings, updated_at) ON app.post_variants TO shoutory_definer;

-- The seed policy exists only for this insert.
CREATE POLICY retention_seed_insert ON app.retention_classes FOR INSERT TO shoutory_owner WITH CHECK (true);
INSERT INTO app.retention_classes (class, table_name, kind, event_column, retain, partition_unit) VALUES
  ('app.idempotency_keys', 'app.idempotency_keys', 'window', 'expires_at', interval '1 hour', NULL);
DROP POLICY retention_seed_insert ON app.retention_classes;
CALL app.grant_purposes('idempotency_keys', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('idempotency_keys', 'DELETE', ARRAY['purge_expired']);

-- One purpose per definer; the principal check reads the tenancy tables under the calling definer's purpose.
DO $$
DECLARE
  t text;
  p text;
  all_purposes constant text[] := ARRAY['post_create', 'post_autosave', 'post_save', 'post_restore'];
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles', 'posts', 'post_variants',
    'post_media'] LOOP
    CALL app.grant_purposes(t, 'SELECT', all_purposes);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['posts', 'post_versions', 'post_variants', 'post_media'] LOOP
    CALL app.grant_purposes(t, 'INSERT', all_purposes);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['post_variants', 'post_media'] LOOP
    CALL app.grant_purposes(t, 'DELETE', all_purposes);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['posts', 'post_variants'] LOOP
    CALL app.grant_purposes(t, 'UPDATE', all_purposes);
  END LOOP;
  CALL app.grant_purposes('post_versions', 'SELECT', ARRAY['post_autosave', 'post_save', 'post_restore']);
END
$$;

SET ROLE shoutory_definer;

-- Not an entry point: no runtime role may run it. The caller holds the post row lock; the existing variants are locked
-- by ascending id before any is written.
CREATE FUNCTION app.post_apply_draft(workspace_id uuid, post_id uuid, draft jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r record;
  vid uuid;
  kept uuid[] := '{}';
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
    SELECT x.* FROM jsonb_array_elements(post_apply_draft.draft -> 'variants') AS e (value),
      jsonb_to_record(e.value) AS x (channel_id uuid, locale text, post_type text, "text" text, parts jsonb,
        settings jsonb, media jsonb)
  LOOP
    SELECT v.id INTO vid FROM app.post_variants AS v
      WHERE v.workspace_id = post_apply_draft.workspace_id AND v.post_id = post_apply_draft.post_id
        AND v.channel_id = r.channel_id AND v.locale IS NOT DISTINCT FROM r.locale;
    IF vid IS NOT NULL AND vid = ANY (kept) THEN
      RAISE EXCEPTION 'post: two variants of one channel and locale' USING ERRCODE = '23505';
    ELSIF vid IS NOT NULL THEN
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
  DELETE FROM app.post_variants AS v
    WHERE v.workspace_id = post_apply_draft.workspace_id AND v.post_id = post_apply_draft.post_id AND v.id <> ALL (kept);
END
$$;

CREATE FUNCTION app.post_create(workspace_id uuid, snapshot jsonb, snapshot_hash bytea)
RETURNS TABLE (post_id uuid, version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  new_post constant uuid := uuidv7();
  new_version constant uuid := uuidv7();
BEGIN
  PERFORM set_config('app.job_purpose', 'post_create', true);
  PERFORM app.media_caller(post_create.workspace_id, 3, false);
  INSERT INTO app.posts (id, workspace_id, author_kind, author_id)
    VALUES (new_post, post_create.workspace_id, app.principal_kind(), app.principal_id());
  INSERT INTO app.post_versions (id, workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
    VALUES (new_version, post_create.workspace_id, new_post, 1, 'save', post_create.snapshot,
      post_create.snapshot_hash, app.principal_id());
  PERFORM app.post_apply_draft(post_create.workspace_id, new_post, post_create.snapshot -> 'draft');
  UPDATE app.posts AS p SET current_version_id = new_version, updated_at = clock_timestamp() WHERE p.id = new_post;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  post_id := new_post;
  version_id := new_version;
  RETURN NEXT;
END
$$;

-- Not an entry point: no runtime EXECUTE. The post row lock orders concurrent writers. A stale expected version
-- changes nothing and returns the current version. An unknown, deleted or foreign post is refused like any other
-- foreign row.
CREATE FUNCTION app.post_write_version(
  workspace_id uuid, post_id uuid, expected_version uuid, snapshot jsonb, snapshot_hash bytea, kind text)
RETURNS TABLE (outcome text, version_id uuid)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_id uuid;
  new_version constant uuid := uuidv7();
BEGIN
  SELECT p.current_version_id INTO current_id FROM app.posts AS p
    WHERE p.id = post_write_version.post_id AND p.workspace_id = post_write_version.workspace_id
      AND p.deleted_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post: refused' USING ERRCODE = '42501';
  END IF;
  IF current_id IS DISTINCT FROM post_write_version.expected_version THEN
    outcome := 'stale';
    version_id := current_id;
    RETURN NEXT;
    RETURN;
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
  outcome := 'ok';
  version_id := new_version;
  RETURN NEXT;
END
$$;

CREATE FUNCTION app.post_autosave(
  workspace_id uuid, post_id uuid, expected_version uuid, snapshot jsonb, snapshot_hash bytea)
RETURNS TABLE (outcome text, version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'post_autosave', true);
  PERFORM app.media_caller(post_autosave.workspace_id, 3, false);
  RETURN QUERY SELECT w.outcome, w.version_id FROM app.post_write_version(post_autosave.workspace_id,
    post_autosave.post_id, post_autosave.expected_version, post_autosave.snapshot, post_autosave.snapshot_hash,
    'autosave') AS w;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

CREATE FUNCTION app.post_save(
  workspace_id uuid, post_id uuid, expected_version uuid, snapshot jsonb, snapshot_hash bytea)
RETURNS TABLE (outcome text, version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'post_save', true);
  PERFORM app.media_caller(post_save.workspace_id, 3, false);
  RETURN QUERY SELECT w.outcome, w.version_id FROM app.post_write_version(post_save.workspace_id, post_save.post_id,
    post_save.expected_version, post_save.snapshot, post_save.snapshot_hash, 'save') AS w;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- A source that is not a version of this post is refused like an unknown post.
CREATE FUNCTION app.post_restore(workspace_id uuid, post_id uuid, expected_version uuid, source_version uuid)
RETURNS TABLE (outcome text, version_id uuid)
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
  RETURN QUERY SELECT w.outcome, w.version_id FROM app.post_write_version(post_restore.workspace_id,
    post_restore.post_id, post_restore.expected_version, old.snapshot, old.snapshot_hash, 'save') AS w;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.post_apply_draft(uuid, uuid, jsonb), app.post_write_version(uuid, uuid, uuid, jsonb, bytea, text),
  app.post_create(uuid, jsonb, bytea),
  app.post_autosave(uuid, uuid, uuid, jsonb, bytea), app.post_save(uuid, uuid, uuid, jsonb, bytea),
  app.post_restore(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.post_create(uuid, jsonb, bytea), app.post_autosave(uuid, uuid, uuid, jsonb, bytea),
  app.post_save(uuid, uuid, uuid, jsonb, bytea), app.post_restore(uuid, uuid, uuid, uuid) TO shoutory_app;
RESET ROLE;
