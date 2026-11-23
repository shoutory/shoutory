-- Media gating: completing an upload leaves the event that starts the image pipeline, in the same transaction, and
-- admission leaves a target alone while the media of its frozen version are not ready.

-- The outbox belongs to the definer role (0012); its insert policies are created by it, in the form app.grant_purposes
-- gives them (the 0020 note).
SET ROLE shoutory_definer;

CREATE POLICY media_mark_uploaded_insert ON app.outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'media_mark_uploaded');

-- media_mark_uploaded of 0016, with one change: an `ok` completion writes one `media.uploaded` event for the asset. A
-- duplicate writes none, since its new asset is deleted. The event is the last write, after the asset row (lock rank 7a)
-- and its upload row, and so after nothing it waits on (OL 4.4, outbox rank 10).
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

REVOKE ALL ON FUNCTION app.media_mark_uploaded(uuid, uuid, bytea, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_mark_uploaded(uuid, uuid, bytea, bigint, text) TO shoutory_app;
RESET ROLE;

-- Admission reads the state of the media a frozen version names: the table SELECT of the definer exists (0016), the
-- purpose's policy is this one. `post_versions` and `workspaces` are read under it already (0021).
CALL app.grant_purposes('media_assets', 'SELECT', ARRAY['admit_due_targets']);

SET ROLE shoutory_definer;

-- Admission of 0022, with one change: a target that is not late is left `scheduled` while any medium of its frozen
-- snapshot is not `ready` in its own workspace (a missing or foreign id, `rejected` and `deleted` count as not ready), and
-- is taken on a later tick once they are. A late target is taken as before, so it ends `missed`. The check is a plain read
-- in the row query: no lock, no new rank (OL 4.4), and a skipped row never fills the limit. The media ids are the keys of
-- `resolved.media`, never the live `post_media` rows, and a key that is no uuid counts as not ready, so no row can abort
-- the admission of the others.
CREATE OR REPLACE FUNCTION app.admit_due_targets(p_limit integer, p_providers jsonb)
RETURNS TABLE (operation_id uuid, workspace_id uuid, queue text, state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r record;
  st text;
  reason text;
  tolerance interval;
  org uuid;
  ch text;
  secs integer;
  digest text;
  new_op uuid;
  cname text;
  added boolean;
  late boolean;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'admit_due_targets', true);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR jsonb_typeof(p_providers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'admit_due_targets: the limit is 1 to 500 and the providers an object' USING ERRCODE = '22023';
  END IF;
  -- The lease of a provider is a positive whole number of seconds; a value that is not is the caller's defect and no target is read.
  IF EXISTS (SELECT 1 FROM jsonb_each(p_providers) AS e (provider, facts)
      WHERE NOT coalesce(jsonb_typeof(e.facts -> 'lease_seconds' -> 'publish') = 'number'
        AND (e.facts -> 'lease_seconds' ->> 'publish') ~ '^[1-9][0-9]{0,8}$', false)) THEN
    RAISE EXCEPTION 'admit_due_targets: the publish lease of every provider is a positive whole number of seconds'
      USING ERRCODE = '22023';
  END IF;
  -- Only the target row is locked (OF v). The workspace row is read, not locked; it is named first because the
  -- lock-order check counts every table of a locking statement and the workspace rank comes before the target's.
  FOR r IN
    SELECT v.id AS variant_id, v.workspace_id AS ws, v.channel_id, v.due_at, v.frozen_version_id, c.provider_id,
        p.author_id, p.id AS post_id
      FROM app.workspaces AS w
      JOIN app.post_variants AS v ON v.workspace_id = w.id
      JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      WHERE v.schedule_state = 'scheduled' AND v.due_at IS NOT NULL AND p.deleted_at IS NULL AND p.status <> 'archived'
        AND jsonb_exists(p_providers, c.provider_id)
        AND v.due_at <= clock_timestamp() + make_interval(secs => (p_providers -> c.provider_id ->> 'margin_seconds')::float8)
        AND (clock_timestamp() > v.due_at + w.lateness_tolerance OR NOT EXISTS (
          SELECT 1 FROM app.post_versions AS pv
            CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(pv.snapshot -> 'resolved' -> 'media') = 'object'
              THEN pv.snapshot -> 'resolved' -> 'media' ELSE '{}'::jsonb END) AS m (media_id)
            LEFT JOIN app.media_assets AS a ON a.workspace_id = v.workspace_id
              AND a.id = CASE WHEN m.media_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN m.media_id::uuid END
            WHERE pv.workspace_id = v.workspace_id AND pv.id = v.frozen_version_id AND a.state IS DISTINCT FROM 'ready'))
      ORDER BY v.due_at, v.id LIMIT p_limit FOR UPDATE OF v SKIP LOCKED
  LOOP
    added := false;
    BEGIN
      SELECT w.lateness_tolerance, w.organization_id INTO tolerance, org FROM app.workspaces AS w WHERE w.id = r.ws;
      late := clock_timestamp() > r.due_at + tolerance;
      IF late THEN
        PERFORM 1 FROM app.posts AS p WHERE p.workspace_id = r.ws AND p.id = r.post_id FOR NO KEY UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
          CONTINUE;
        END IF;
      END IF;
      SELECT c.connection_state INTO ch FROM app.channels AS c WHERE c.workspace_id = r.ws AND c.id = r.channel_id FOR SHARE;
      IF late THEN
        st := 'missed'; reason := NULL;
      ELSIF ch = 'connected' THEN
        st := 'pending'; reason := NULL;
      ELSIF ch = 'disabled' THEN
        st := 'paused'; reason := 'channel_disabled';
      ELSE
        st := 'blocked_reconnect'; reason := 'pending';
      END IF;
      secs := (p_providers -> r.provider_id -> 'lease_seconds' ->> 'publish')::integer;
      SELECT encode(pv.snapshot_hash, 'hex') INTO digest FROM app.post_versions AS pv
        WHERE pv.workspace_id = r.ws AND pv.id = r.frozen_version_id;
      new_op := app.operation_insert(r.ws, jsonb_strip_nulls(jsonb_build_object(
        'variant_id', r.variant_id, 'channel_id', r.channel_id, 'provider_id', r.provider_id,
        'queue', 'publish.' || r.provider_id, 'kind', 'publish', 'part_index', 0, 'state', st, 'reason_code', reason,
        'due_at', r.due_at, 'lateness_deadline', r.due_at + tolerance, 'next_attempt_at', r.due_at,
        'blocked_since', CASE WHEN st = 'blocked_reconnect' THEN clock_timestamp() END,
        'idempotency_marker', 'admit-' || uuidv7()::text, 'requested_by', r.author_id, 'lease_seconds', secs,
        'frozen_version_id', CASE WHEN digest IS NOT NULL THEN r.frozen_version_id END,
        'frozen_snapshot_hash', digest)), 'S');
      IF st <> 'missed' THEN
        INSERT INTO app.usage_reservations (workspace_id, organization_id, operation_id, key, amount)
          VALUES (r.ws, org, new_op, 'posts_per_month', 1);
        UPDATE app.post_variants AS v SET schedule_state = CASE WHEN st = 'blocked_reconnect' THEN 'held' ELSE 'in_progress' END
          WHERE v.workspace_id = r.ws AND v.id = r.variant_id;
      END IF;
      INSERT INTO app.outbox (workspace_id, type, payload)
        VALUES (r.ws, 'operation.admitted', jsonb_build_object('operation_id', new_op, 'state', st));
      added := true;
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'operations_target_key' THEN
          RAISE;
        END IF;
      WHEN SQLSTATE 'SH409' THEN
        NULL;
    END;
    IF added THEN
      operation_id := new_op; workspace_id := r.ws; queue := 'publish.' || r.provider_id; state := st;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.job_purpose', 'ledger', true);
END
$$;

REVOKE ALL ON FUNCTION app.admit_due_targets(integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admit_due_targets(integer, jsonb) TO shoutory_worker;
RESET ROLE;
