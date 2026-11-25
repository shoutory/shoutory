-- A video now has a `stripped` copy too, made without the location and other metadata its original may hold, so it is
-- sent and pinned like an image. A video made ready before that has no copy and is no longer sendable.
SET ROLE shoutory_definer;

-- FOR SHARE in ascending id conflicts with the collection's take and with a post attach, so the pin and either of
-- them are serialized; the assets are read again once locked. A medium that is missing, in another workspace, not
-- ready, or with no ready `stripped` copy raises SH422: admission leaves the target scheduled, and a resolution
-- answers `media_unavailable`. It is called before an operation that sends again is moved, because the move fires
-- triggers that write tables locked after the assets.
CREATE OR REPLACE FUNCTION app.operation_media_lock(p_ws uuid, p_version uuid, p_op uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  ids uuid[];
  total integer;
  bad integer;
  ready integer;
BEGIN
  IF p_version IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.job_purpose', 'operation_media_lock', true);
  -- A key that is no uuid is a medium that cannot be ready.
  SELECT array_agg(DISTINCT (m.item ->> 'media_id')::uuid) FILTER (WHERE valid.ok), count(*),
      count(*) FILTER (WHERE NOT valid.ok) INTO ids, total, bad
    FROM app.operations AS o
      JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
      JOIN app.post_versions AS pv ON pv.workspace_id = o.workspace_id AND pv.id = p_version
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pv.snapshot -> 'draft' -> 'variants') = 'array'
        THEN pv.snapshot -> 'draft' -> 'variants' ELSE '[]'::jsonb END) AS dv (item)
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(dv.item -> 'media') = 'array'
        THEN dv.item -> 'media' ELSE '[]'::jsonb END) AS m (item)
      CROSS JOIN LATERAL (SELECT coalesce(m.item ->> 'media_id' ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) AS ok) AS valid
    WHERE o.workspace_id = p_ws AND o.id = p_op AND lower(dv.item ->> 'channel_id') = o.channel_id::text
      AND dv.item ->> 'locale' IS NOT DISTINCT FROM v.locale;
  IF total > 0 THEN
    PERFORM a.id FROM app.media_assets AS a WHERE a.workspace_id = p_ws AND a.id = ANY (ids) ORDER BY a.id FOR SHARE;
    SELECT count(*) INTO ready FROM app.media_assets AS a
      WHERE a.workspace_id = p_ws AND a.id = ANY (ids) AND a.state = 'ready'
        AND EXISTS (SELECT 1 FROM app.media_derivatives AS d
          WHERE d.workspace_id = a.workspace_id AND d.media_id = a.id AND d.profile = 'stripped' AND d.state = 'ready');
    IF bad > 0 OR ready <> coalesce(cardinality(ids), 0) THEN
      RAISE EXCEPTION 'resolve_operation: media_unavailable' USING ERRCODE = 'SH422';
    END IF;
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Every medium pins its ready `stripped` copy and that copy's hash. It takes no lock because the lock function is
-- called first, so nothing it reads can change, and it raises the same SH422 when it did not write one row for every
-- medium.
CREATE OR REPLACE FUNCTION app.operation_media_pin(p_ws uuid, p_op uuid, p_version uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  items jsonb;
  written integer;
BEGIN
  IF p_version IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.job_purpose', 'operation_media_pin', true);
  -- A key that is no uuid is a medium that cannot be ready.
  SELECT coalesce(jsonb_agg(jsonb_build_object('pos', m.ord - 1,
      'media_id', CASE WHEN m.item ->> 'media_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN m.item ->> 'media_id' END) ORDER BY m.ord), '[]'::jsonb) INTO items
    FROM app.operations AS o
      JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
      JOIN app.post_versions AS pv ON pv.workspace_id = o.workspace_id AND pv.id = p_version
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pv.snapshot -> 'draft' -> 'variants') = 'array'
        THEN pv.snapshot -> 'draft' -> 'variants' ELSE '[]'::jsonb END) AS dv (item)
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(dv.item -> 'media') = 'array'
        THEN dv.item -> 'media' ELSE '[]'::jsonb END) WITH ORDINALITY AS m (item, ord)
    WHERE o.workspace_id = p_ws AND o.id = p_op AND lower(dv.item ->> 'channel_id') = o.channel_id::text
      AND dv.item ->> 'locale' IS NOT DISTINCT FROM v.locale;
  INSERT INTO app.operation_media (workspace_id, operation_id, position, media_id, derivative_id, derivative_sha256)
    SELECT p_ws, p_op, i.pos, i.media_id, d.id, d.sha256
    FROM jsonb_to_recordset(items) AS i (pos smallint, media_id uuid)
      JOIN app.media_assets AS a ON a.workspace_id = p_ws AND a.id = i.media_id AND a.state = 'ready'
      JOIN app.media_derivatives AS d ON d.workspace_id = a.workspace_id AND d.media_id = a.id
        AND d.profile = 'stripped' AND d.state = 'ready';
  GET DIAGNOSTICS written = ROW_COUNT;
  IF written <> jsonb_array_length(items) THEN
    RAISE EXCEPTION 'resolve_operation: media_unavailable' USING ERRCODE = 'SH422';
  END IF;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

RESET ROLE;
