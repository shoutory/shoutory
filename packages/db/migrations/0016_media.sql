-- The media schema: the uploaded files of a workspace, their upload sessions and their derivatives, and the definers that
-- are their only writers (a later file adds the post and operation references). The runtime roles read the tables and
-- never write them: every change is a definer under its own purpose policy, so an original is named once, kept per
-- workspace and moved only through checked states.

-- One row per uploaded original. The state moves pending_upload -> uploaded -> (scanning) -> processing -> ready, to
-- rejected from scanning or processing, and to deleted from the states the move table of media_advance names. The
-- object key is `ws/<workspace>/<asset>/1/original` (version 1 until the editor makes new versions) and always starts
-- with its own workspace prefix. A hash is unique among the live states of one workspace.
CREATE TABLE app.media_assets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  object_key text NOT NULL CHECK (char_length(object_key) <= 512),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime text CHECK (char_length(mime) BETWEEN 1 AND 255),
  byte_size bigint CHECK (byte_size > 0),
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  duration_ms integer CHECK (duration_ms > 0),
  codec_facts jsonb CHECK (octet_length(codec_facts::text) <= 16384),
  sha256 bytea CHECK (octet_length(sha256) = 32),
  state text NOT NULL DEFAULT 'pending_upload' CHECK (state IN (
    'pending_upload', 'uploaded', 'scanning', 'processing', 'ready', 'rejected', 'deleted')),
  reject_reason text CHECK (char_length(reject_reason) <= 200),
  in_library boolean NOT NULL DEFAULT false,
  -- At most 32 tags of 1 to 64 characters: the array text with an unprintable separator is matched as a whole.
  tags text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(tags) <= 32 AND array_position(tags, '') IS NULL AND array_position(tags, NULL) IS NULL
    AND array_to_string(tags, E'\x1f') ~ E'^[^\x1f]{0,64}(\x1f[^\x1f]{0,64}){0,31}$'),
  source text NOT NULL CHECK (source IN ('upload', 'url_import', 'ai', 'editor')),
  source_ref text CHECK (char_length(source_ref) BETWEEN 1 AND 256),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  object_removed_at timestamptz,
  CONSTRAINT media_assets_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT media_assets_object_key_key UNIQUE (workspace_id, object_key),
  CONSTRAINT media_assets_key_prefix_check CHECK (object_key LIKE 'ws/' || workspace_id::text || '/%'),
  CONSTRAINT media_assets_live_hash_check CHECK (
    state NOT IN ('uploaded', 'scanning', 'processing', 'ready') OR sha256 IS NOT NULL)
);
-- shoutory:accepted-lock new empty table in this file
CREATE UNIQUE INDEX media_assets_live_hash_key ON app.media_assets (workspace_id, sha256)
  WHERE state IN ('uploaded', 'scanning', 'processing', 'ready');
-- The pending-upload arm of the garbage collection reads the old ones by age.
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX media_assets_pending_idx ON app.media_assets (state, created_at) WHERE state = 'pending_upload';
-- The deleted arm reads the assets whose object is still stored by the day they were deleted.
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX media_assets_deleted_idx ON app.media_assets (deleted_at) WHERE state = 'deleted' AND object_removed_at IS NULL;
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX media_assets_tags_idx ON app.media_assets USING gin (tags);
SELECT app.apply_rls_template('app.media_assets'::regclass, 'W');

-- One row per upload (the multipart id and the parts are empty for a single request); it goes with its asset.
CREATE TABLE app.media_uploads (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  media_id uuid NOT NULL,
  multipart_upload_id text CHECK (char_length(multipart_upload_id) BETWEEN 1 AND 1024),
  part_size integer CHECK (part_size > 0),
  parts_done integer[] CHECK (cardinality(parts_done) <= 10000),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  FOREIGN KEY (workspace_id, media_id) REFERENCES app.media_assets (workspace_id, id) ON DELETE CASCADE
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX media_uploads_open_idx ON app.media_uploads (expires_at) WHERE completed_at IS NULL;
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX media_uploads_asset_idx ON app.media_uploads (workspace_id, media_id);
SELECT app.apply_rls_template('app.media_uploads'::regclass, 'W');

-- A processed copy of an original (a thumbnail, a transcode for one provider): one per profile, pending until the
-- pipeline marks it ready or failed once; it goes with its asset.
CREATE TABLE app.media_derivatives (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  media_id uuid NOT NULL,
  profile text NOT NULL CHECK (char_length(profile) BETWEEN 1 AND 64),
  object_key text NOT NULL CHECK (char_length(object_key) <= 512),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'failed')),
  sha256 bytea CHECK (octet_length(sha256) = 32),
  byte_size bigint CHECK (byte_size > 0),
  error text CHECK (char_length(error) <= 500),
  CONSTRAINT media_derivatives_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT media_derivatives_profile_key UNIQUE (workspace_id, media_id, profile),
  CONSTRAINT media_derivatives_object_key_key UNIQUE (workspace_id, object_key),
  CONSTRAINT media_derivatives_key_prefix_check CHECK (object_key LIKE 'ws/' || workspace_id::text || '/%'),
  FOREIGN KEY (workspace_id, media_id) REFERENCES app.media_assets (workspace_id, id) ON DELETE CASCADE
);
SELECT app.apply_rls_template('app.media_derivatives'::regclass, 'W');

-- The runtime roles read the media tables and write nothing (0013, 0015): the definers below are the only writers.
GRANT SELECT ON app.media_assets, app.media_uploads, app.media_derivatives TO shoutory_app, shoutory_worker;
GRANT SELECT, INSERT ON app.media_assets, app.media_derivatives TO shoutory_definer;
GRANT SELECT, INSERT, DELETE ON app.media_uploads TO shoutory_definer;
-- Never the key or the workspace of a row: an original is named once.
GRANT UPDATE (file_name, mime, byte_size, width, height, duration_ms, codec_facts, sha256, state, reject_reason,
  in_library, tags, deleted_at, object_removed_at) ON app.media_assets TO shoutory_definer;
GRANT UPDATE (parts_done, completed_at) ON app.media_uploads TO shoutory_definer;
GRANT UPDATE (state, sha256, byte_size, error) ON app.media_derivatives TO shoutory_definer;

-- The workspace's avatar is one of its own assets. Existing rows hold no avatar, so the key is added NOT VALID here and
-- validated by the first expand migration (the lock is brief: workspaces is small and the asset table is empty).
-- shoutory:accepted-lock a brief SHARE ROW EXCLUSIVE on workspaces and the new empty media_assets
ALTER TABLE app.workspaces ADD CONSTRAINT workspaces_avatar_fkey
  FOREIGN KEY (id, avatar) REFERENCES app.media_assets (workspace_id, id) NOT VALID;

-- An upload session is removed 7 days after the later of its completion and its expiry, which outlives the 7-day
-- multipart abort (the 0012 registry; the 0015 way of seeding it under a policy that exists only for this statement).
CREATE POLICY retention_seed_insert ON app.retention_classes FOR INSERT TO shoutory_owner WITH CHECK (true);
INSERT INTO app.retention_classes (class, table_name, kind, event_column, retain, partition_unit) VALUES
  ('app.media_uploads', 'app.media_uploads', 'window', 'GREATEST(completed_at, expires_at)', interval '7 days', NULL);
DROP POLICY retention_seed_insert ON app.retention_classes;
CALL app.grant_purposes('media_uploads', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('media_uploads', 'DELETE', ARRAY['purge_expired']);

-- The principal check reads the tables of the tenancy rank, under the purpose of the definer that calls it.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['media_register', 'media_mark_uploaded', 'media_advance',
      'media_derivative_put', 'media_upload_progress', 'media_set_metadata', 'media_object_removed']);
  END LOOP;
END
$$;
-- The workspace row lock of media_register passes the lock policy (0010) and refuses every real update.
CALL app.grant_purposes('workspaces', 'UPDATE', ARRAY['media_register']);
CALL app.grant_purposes('media_assets', 'SELECT', ARRAY['media_register', 'media_mark_uploaded']);
CALL app.grant_purposes('media_assets', 'INSERT', ARRAY['media_register']);
CALL app.grant_purposes('media_assets', 'UPDATE', ARRAY['media_mark_uploaded']);
CALL app.grant_purposes('media_uploads', 'SELECT', ARRAY['media_mark_uploaded']);
CALL app.grant_purposes('media_uploads', 'INSERT', ARRAY['media_register']);
CALL app.grant_purposes('media_uploads', 'UPDATE', ARRAY['media_mark_uploaded']);

-- The guard function is created by the definer role, which needs the right to attach it; the right goes again after.
GRANT TRIGGER ON app.media_assets, app.media_derivatives TO shoutory_definer;
SET ROLE shoutory_definer;

-- The one principal check of the media writers (R551): a user whose rank in the workspace is `min_rank` or more, or (when
-- `job_ok`) a job principal whose workspace set holds it. Any other kind, a lower rank and a foreign workspace get the
-- same refusal. It takes no lock: the media writers lock one asset row each, and a workspace lock would serialise them.
CREATE FUNCTION app.media_caller(workspace_id uuid, min_rank integer, job_ok boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  kind constant text := app.principal_kind();
  ok boolean;
BEGIN
  IF kind = 'user' THEN
    ok := app.principal_id() IS NOT NULL
      AND app.tenancy_rank(media_caller.workspace_id, app.principal_id()) >= media_caller.min_rank;
  ELSIF kind = 'job' THEN
    ok := media_caller.job_ok AND media_caller.workspace_id = ANY (app.ws_ids());
  END IF;
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
END
$$;

-- An original is immutable: once an asset is no longer pending its key and hash cannot change, and a derivative's cannot
-- once it is no longer pending, whoever runs the statement (the table owner and a superuser included).
CREATE FUNCTION app.media_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.object_key IS DISTINCT FROM OLD.object_key)
     AND OLD.state <> (CASE TG_TABLE_NAME WHEN 'media_assets' THEN 'pending_upload' ELSE 'pending' END) THEN
    RAISE EXCEPTION 'media: an original is immutable' USING ERRCODE = 'SH409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER media_assets_guard BEFORE UPDATE OF sha256, object_key ON app.media_assets
  FOR EACH ROW EXECUTE FUNCTION app.media_guard();
CREATE TRIGGER media_derivatives_guard BEFORE UPDATE OF sha256, object_key ON app.media_derivatives
  FOR EACH ROW EXECUTE FUNCTION app.media_guard();

-- Starts an upload for a user Editor or above: a pending asset with its derived key and its upload session (24 hours).
-- A workspace holds at most 100 pending uploads, counted under the workspace row lock so that concurrent registers
-- cannot pass the cap together.
CREATE FUNCTION app.media_register(
  workspace_id uuid, file_name text, mime text, source text, source_ref text, multipart_upload_id text,
  part_size integer)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  new_id constant uuid := uuidv7();
BEGIN
  PERFORM set_config('app.job_purpose', 'media_register', true);
  PERFORM app.media_caller(media_register.workspace_id, 3, false);
  -- The workspace row, FOR NO KEY UPDATE (lock rank 1a), orders concurrent registers: the count below sees the last one.
  PERFORM 1 FROM app.workspaces AS w WHERE w.id = media_register.workspace_id FOR NO KEY UPDATE;
  IF (SELECT count(*) FROM app.media_assets AS a
      WHERE a.workspace_id = media_register.workspace_id AND a.state = 'pending_upload') >= 100 THEN
    RAISE EXCEPTION 'media_register: at most 100 pending uploads' USING ERRCODE = '53400';
  END IF;
  INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, source_ref, created_by)
    VALUES (new_id, media_register.workspace_id,
      'ws/' || media_register.workspace_id::text || '/' || new_id::text || '/1/original', media_register.file_name,
      media_register.mime, media_register.source, media_register.source_ref, app.principal_id());
  INSERT INTO app.media_uploads (workspace_id, media_id, multipart_upload_id, part_size, expires_at)
    VALUES (media_register.workspace_id, new_id, media_register.multipart_upload_id, media_register.part_size,
      clock_timestamp() + interval '24 hours');
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;

-- Completes an upload for a user Editor or above: the pending asset takes its hash and facts and becomes uploaded. A hash
-- that is already live in the workspace is answered as `duplicate` with the live asset's id, and the new asset is
-- deleted ("already in your library"). The unique index decides, so two callers marking the same hash at once end with
-- one `ok` and one `duplicate`: the loser's unique violation is caught here and never reaches the caller.
CREATE FUNCTION app.media_mark_uploaded(workspace_id uuid, asset_id uuid, digest bytea, byte_size bigint, mime text)
RETURNS TABLE (outcome text, live_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  was text;
  existing uuid;
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
    -- The live asset was deleted between the violation and this read: the caller tries again.
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
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  live_id := existing;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION app.media_caller(uuid, integer, boolean), app.media_guard(),
  app.media_register(uuid, text, text, text, text, text, integer),
  app.media_mark_uploaded(uuid, uuid, bytea, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_register(uuid, text, text, text, text, text, integer),
  app.media_mark_uploaded(uuid, uuid, bytea, bigint, text) TO shoutory_app;
RESET ROLE;
REVOKE TRIGGER ON app.media_assets, app.media_derivatives FROM shoutory_definer;

-- The remaining writers: the state moves, the derivatives, the upload progress, the metadata, the closing step of the
-- garbage collection and its candidate list.
CALL app.grant_purposes('media_assets', 'SELECT', ARRAY['media_advance', 'media_derivative_put',
  'media_upload_progress', 'media_set_metadata', 'media_object_removed', 'media_gc_candidates']);
-- A row lock (FOR UPDATE) passes the UPDATE policy, so the two writers that only lock the asset hold it too.
CALL app.grant_purposes('media_assets', 'UPDATE', ARRAY['media_advance', 'media_set_metadata',
  'media_object_removed', 'media_derivative_put', 'media_upload_progress']);
CALL app.grant_purposes('media_uploads', 'SELECT', ARRAY['media_upload_progress']);
CALL app.grant_purposes('media_uploads', 'UPDATE', ARRAY['media_upload_progress']);
CALL app.grant_purposes('media_derivatives', 'SELECT', ARRAY['media_derivative_put']);
CALL app.grant_purposes('media_derivatives', 'INSERT', ARRAY['media_derivative_put']);
CALL app.grant_purposes('media_derivatives', 'UPDATE', ARRAY['media_derivative_put']);

SET ROLE shoutory_definer;

-- The one move table (R551), enforced here and nowhere else. Every move needs a member of the workspace (a user Editor or
-- above, or a job of it); the pipeline moves are job-only, so a user never reaches scanning, processing, ready or
-- rejected, and only a job frees a stuck asset (and its hash) by deleting it from uploaded, scanning or processing.
-- `deleted` is terminal, and pending_upload -> uploaded is only media_mark_uploaded's. A move that is not in
-- the table, or whose from_state is not the row's state, is SH409 and changes nothing.
CREATE FUNCTION app.media_advance(
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
    ('processing', 'rejected', true), ('ready', 'deleted', false), ('rejected', 'deleted', false),
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
  -- Facts are the pipeline's: a person's move carries none, and a fact that is malformed or out of range is 22023.
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

-- The pipeline's derivative of an original, for a job: a pending row is inserted (its key is derived like the
-- original's) and moved once to ready or failed. A second pending row for the profile, or a move of a row that is no
-- longer pending, is SH409: nothing is overwritten.
CREATE FUNCTION app.media_derivative_put(
  workspace_id uuid, asset_id uuid, profile text, state text, digest bytea, byte_size bigint, error text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  made uuid;
  was text;
BEGIN
  PERFORM set_config('app.job_purpose', 'media_derivative_put', true);
  PERFORM app.media_caller(media_derivative_put.workspace_id, 6, true);
  SELECT a.state INTO was FROM app.media_assets AS a
    WHERE a.workspace_id = media_derivative_put.workspace_id AND a.id = media_derivative_put.asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  -- `original` is the key of the original itself; a ready derivative has its hash and size, a failed one its error.
  IF media_derivative_put.state NOT IN ('pending', 'ready', 'failed')
     OR media_derivative_put.profile !~ '^[a-z0-9][a-z0-9_.-]{0,63}$' OR media_derivative_put.profile = 'original'
     OR (media_derivative_put.state = 'ready' AND (octet_length(media_derivative_put.digest) IS DISTINCT FROM 32
       OR coalesce(media_derivative_put.byte_size, 0) <= 0))
     OR (media_derivative_put.state = 'failed' AND media_derivative_put.error IS NULL) THEN
    RAISE EXCEPTION 'media_derivative_put: the profile, the state or its facts are not valid' USING ERRCODE = '22023';
  END IF;
  IF was NOT IN ('processing', 'ready') THEN
    RAISE EXCEPTION 'media_derivative_put: the asset is not being processed' USING ERRCODE = 'SH409';
  END IF;
  IF media_derivative_put.state = 'pending' THEN
    BEGIN
      INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key)
        VALUES (media_derivative_put.workspace_id, media_derivative_put.asset_id, media_derivative_put.profile,
          'ws/' || media_derivative_put.workspace_id::text || '/' || media_derivative_put.asset_id::text || '/1/'
          || media_derivative_put.profile)
        RETURNING id INTO made;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'media_derivative_put: that derivative already exists' USING ERRCODE = 'SH409';
    END;
  ELSE
    UPDATE app.media_derivatives AS d SET state = media_derivative_put.state, sha256 = media_derivative_put.digest,
        byte_size = media_derivative_put.byte_size, error = media_derivative_put.error
      WHERE d.workspace_id = media_derivative_put.workspace_id AND d.media_id = media_derivative_put.asset_id
        AND d.profile = media_derivative_put.profile AND d.state = 'pending'
      RETURNING d.id INTO made;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'media_derivative_put: there is no pending derivative to move' USING ERRCODE = 'SH409';
    END IF;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN made;
END
$$;

-- The parts of a multipart upload done so far, for a user Editor or above or a job, on the open session of a pending
-- upload; any other call is SH409, never a silent no-op.
CREATE FUNCTION app.media_upload_progress(workspace_id uuid, asset_id uuid, parts_done integer[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  was text;
BEGIN
  PERFORM set_config('app.job_purpose', 'media_upload_progress', true);
  PERFORM app.media_caller(media_upload_progress.workspace_id, 3, true);
  SELECT a.state INTO was FROM app.media_assets AS a
    WHERE a.workspace_id = media_upload_progress.workspace_id AND a.id = media_upload_progress.asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  IF was <> 'pending_upload' THEN
    RAISE EXCEPTION 'media_upload_progress: the asset is not a pending upload' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.media_uploads AS u SET parts_done = media_upload_progress.parts_done
    WHERE u.workspace_id = media_upload_progress.workspace_id AND u.media_id = media_upload_progress.asset_id
      AND u.completed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_upload_progress: there is no open upload session' USING ERRCODE = 'SH409';
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- A person's edit of the file name, the tags and the library flag, for a user Editor or above; a NULL argument leaves
-- that field as it is. The bounds are the table's.
CREATE FUNCTION app.media_set_metadata(workspace_id uuid, asset_id uuid, file_name text, tags text[], in_library boolean)
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
      tags = coalesce(media_set_metadata.tags, a.tags), in_library = coalesce(media_set_metadata.in_library, a.in_library)
    WHERE a.workspace_id = media_set_metadata.workspace_id AND a.id = media_set_metadata.asset_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The closing step of the garbage collection, for a job: the object of a deleted asset has been removed from storage.
CREATE FUNCTION app.media_object_removed(workspace_id uuid, asset_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  was text;
BEGIN
  PERFORM set_config('app.job_purpose', 'media_object_removed', true);
  PERFORM app.media_caller(media_object_removed.workspace_id, 6, true);
  SELECT a.state INTO was FROM app.media_assets AS a
    WHERE a.workspace_id = media_object_removed.workspace_id AND a.id = media_object_removed.asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media: refused' USING ERRCODE = '42501';
  END IF;
  IF was <> 'deleted' THEN
    RAISE EXCEPTION 'media_object_removed: only a deleted asset has its object removed' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.media_assets AS a SET object_removed_at = coalesce(a.object_removed_at, clock_timestamp())
    WHERE a.workspace_id = media_object_removed.workspace_id AND a.id = media_object_removed.asset_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The assets whose objects the garbage collection may remove, for a job, in the workspaces of the job: a pending upload
-- older than 24 hours, and a deleted asset 30 days after its deletion whose object is still stored. A later migration
-- adds the arm of the unreferenced asset, which needs the tables that reference media.
CREATE FUNCTION app.media_gc_candidates(lim integer)
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
    SELECT u.workspace_id, u.asset_id, u.object_key, u.arm FROM (
      SELECT a.workspace_id, a.id AS asset_id, a.object_key, 'pending_upload'::text AS arm
        FROM app.media_assets AS a
        WHERE a.workspace_id = ANY (app.ws_ids()) AND a.state = 'pending_upload'
          AND a.created_at <= clock_timestamp() - interval '24 hours'
      UNION ALL
      SELECT a.workspace_id, a.id, a.object_key, 'deleted'::text
        FROM app.media_assets AS a
        WHERE a.workspace_id = ANY (app.ws_ids()) AND a.state = 'deleted' AND a.object_removed_at IS NULL
          AND a.deleted_at <= clock_timestamp() - interval '30 days'
    ) AS u ORDER BY u.asset_id LIMIT media_gc_candidates.lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.media_advance(uuid, uuid, text, text, text, jsonb),
  app.media_derivative_put(uuid, uuid, text, text, bytea, bigint, text),
  app.media_upload_progress(uuid, uuid, integer[]), app.media_set_metadata(uuid, uuid, text, text[], boolean),
  app.media_object_removed(uuid, uuid), app.media_gc_candidates(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_advance(uuid, uuid, text, text, text, jsonb),
  app.media_upload_progress(uuid, uuid, integer[]) TO shoutory_app, shoutory_worker;
GRANT EXECUTE ON FUNCTION app.media_set_metadata(uuid, uuid, text, text[], boolean) TO shoutory_app;
GRANT EXECUTE ON FUNCTION app.media_derivative_put(uuid, uuid, text, text, bytea, bigint, text),
  app.media_object_removed(uuid, uuid), app.media_gc_candidates(integer) TO shoutory_worker;
RESET ROLE;
