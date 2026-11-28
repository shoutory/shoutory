-- A candidate whose only recipient is the author is listed only while the author is a person who still belongs to the
-- workspace, so a notice nobody would receive is not offered again at every tick. The unused `provider` and `reason`
-- variables are no longer carried by a notice or its mail.
CALL app.grant_purposes('workspace_members', 'SELECT', ARRAY['notice_candidates']);

SET ROLE shoutory_definer;

CREATE OR REPLACE FUNCTION app.notice_create(
  workspace_id uuid, user_id uuid, kind text, subject_id uuid, level text, vars jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  made uuid;
  address text;
  language text;
  kept jsonb;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'notice_create', true);
  IF notice_create.kind IS NULL OR notice_create.kind NOT IN ('token_expiry', 'reconnect_deadline', 'needs_human',
      'unverified', 'held_media', 'drafts_day_30')
     OR notice_create.level IS NULL OR char_length(notice_create.level) NOT BETWEEN 1 AND 16
     OR jsonb_typeof(notice_create.vars) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'notice_create: the kind, the level or the variables are not valid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.workspace_members AS m WHERE m.workspace_id = notice_create.workspace_id
      AND m.user_id = notice_create.user_id AND m.status = 'active') THEN
    RAISE EXCEPTION 'notice_create: refused' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'string'
      THEN to_jsonb(left(e.value #>> '{}', 128)) ELSE e.value END), '{}') INTO kept
    FROM jsonb_each(notice_create.vars) AS e
    WHERE e.key IN ('name', 'days') AND jsonb_typeof(e.value) IN ('string', 'number');
  INSERT INTO app.notifications (workspace_id, user_id, kind, subject_id, level, vars)
    VALUES (notice_create.workspace_id, notice_create.user_id, notice_create.kind, notice_create.subject_id,
      notice_create.level, kept)
    ON CONFLICT ON CONSTRAINT notifications_key DO NOTHING
    RETURNING id INTO made;
  IF made IS NULL THEN
    PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
    RETURN false;
  END IF;
  SELECT u.email, coalesce(p.locale, 'en') INTO address, language FROM auth."user" AS u
    LEFT JOIN app.user_profiles AS p ON p.user_id = u.id WHERE u.id = notice_create.user_id;
  INSERT INTO app.email_outbox (id, workspace_id, recipient, template, locale, vars)
    VALUES (uuidv7(), notice_create.workspace_id, address, notice_create.kind, language,
      kept || jsonb_build_object('level', notice_create.level));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION app.notice_candidates(p_limit integer)
RETURNS TABLE (kind text, workspace_id uuid, subject_id uuid, level text, step integer, vars jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM app.ledger_caller();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'notice_candidates: the limit is 1 to 500' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'notice_candidates', true);

  RETURN QUERY
    SELECT 'token_expiry'::text, c.workspace_id, k.id, 'g' || k.generation || ':' || w.days || 'd', 0,
        jsonb_build_object('name', coalesce(c.nickname, c.display_name), 'days', w.days)
      FROM app.channels AS c
      JOIN app.channel_credentials AS k ON k.workspace_id = c.workspace_id AND k.channel_id = c.id
      CROSS JOIN LATERAL (SELECT CASE WHEN k.access_expires_at <= clock_timestamp() + interval '1 day' THEN 1
        WHEN k.access_expires_at <= clock_timestamp() + interval '7 days' THEN 7 ELSE 14 END AS days) AS w
      WHERE c.connection_state = 'connected' AND k.kind = 'channel_token' AND k.state = 'active'
        AND k.refresh_token_digest IS NULL AND k.access_expires_at > clock_timestamp()
        AND k.access_expires_at <= clock_timestamp() + interval '14 days'
        AND NOT EXISTS (SELECT 1 FROM app.notifications AS n WHERE n.workspace_id = c.workspace_id
          AND n.kind = 'token_expiry' AND n.subject_id = k.id
          AND n.level = 'g' || k.generation || ':' || w.days || 'd')
      ORDER BY k.access_expires_at, c.id LIMIT p_limit;

  RETURN QUERY
    SELECT 'reconnect_deadline'::text, c.workspace_id, k.id, 'g' || k.generation || ':' || w.days || 'd', 0,
        jsonb_build_object('name', coalesce(c.nickname, c.display_name), 'days', w.days)
      FROM app.channels AS c
      CROSS JOIN LATERAL (SELECT x.id, x.generation FROM app.channel_credentials AS x
        WHERE x.workspace_id = c.workspace_id AND x.channel_id = c.id ORDER BY x.generation DESC LIMIT 1) AS k
      CROSS JOIN LATERAL (SELECT CASE WHEN c.reconnect_deadline <= clock_timestamp() + interval '1 day' THEN 1
        WHEN c.reconnect_deadline <= clock_timestamp() + interval '7 days' THEN 7 ELSE 14 END AS days) AS w
      WHERE c.connection_state IN ('needs_reconnect', 'disconnected', 'revoked_by_provider')
        AND c.reconnect_deadline > clock_timestamp() AND c.reconnect_deadline <= clock_timestamp() + interval '14 days'
        AND NOT EXISTS (SELECT 1 FROM app.notifications AS n WHERE n.workspace_id = c.workspace_id
          AND n.kind = 'reconnect_deadline' AND n.subject_id = k.id
          AND n.level = 'g' || k.generation || ':' || w.days || 'd')
      ORDER BY c.reconnect_deadline, c.id LIMIT p_limit;

  RETURN QUERY
    SELECT o.state, o.workspace_id, o.id, 'escalation_' || s.next_step, s.next_step,
        jsonb_build_object('name', coalesce(c.nickname, c.display_name))
      FROM app.operations AS o
      JOIN app.channels AS c ON c.workspace_id = o.workspace_id AND c.id = o.channel_id
      CROSS JOIN LATERAL (SELECT coalesce(max(substring(n.level FROM 12)::integer) + 1, 0) AS next_step
        FROM app.notifications AS n WHERE n.workspace_id = o.workspace_id AND n.kind = o.state
          AND n.subject_id = o.id AND n.level ~ '^escalation_[0-9]{1,6}$') AS s
      WHERE o.state IN ('needs_human', 'unverified') AND o.next_escalation_at <= clock_timestamp()
      ORDER BY o.next_escalation_at, o.id LIMIT p_limit;

  RETURN QUERY
    SELECT 'held_media'::text, v.workspace_id, v.id, 'held'::text, 0,
        jsonb_build_object('name', coalesce(c.nickname, c.display_name))
      FROM app.post_variants AS v
      JOIN app.workspaces AS w ON w.id = v.workspace_id
      JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      WHERE w.archived_at IS NULL AND v.schedule_state = 'scheduled' AND v.due_at IS NOT NULL
        AND v.due_at <= clock_timestamp() AND clock_timestamp() <= v.due_at + w.lateness_tolerance
        AND p.deleted_at IS NULL AND p.status <> 'archived' AND v.frozen_version_id IS NOT NULL
        AND p.author_kind = 'user'
        AND EXISTS (SELECT 1 FROM app.workspace_members AS m WHERE m.workspace_id = p.workspace_id
          AND m.user_id = p.author_id AND m.status = 'active')
        AND app.media_held(v.workspace_id, v.frozen_version_id)
        AND NOT EXISTS (SELECT 1 FROM app.notifications AS n WHERE n.workspace_id = v.workspace_id
          AND n.kind = 'held_media' AND n.subject_id = v.id AND n.level = 'held')
      ORDER BY v.due_at, v.id LIMIT p_limit;

  RETURN QUERY
    SELECT 'drafts_day_30'::text, d.workspace_id, d.post_id, '30d'::text, 0,
        jsonb_build_object('name', d.name, 'days', 30)
      FROM (SELECT DISTINCT ON (v.workspace_id, v.post_id) v.workspace_id, v.post_id, o.settled_at,
          coalesce(c.nickname, c.display_name) AS name
        FROM app.operations AS o
        JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
        JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
        JOIN app.channels AS c ON c.workspace_id = o.workspace_id AND c.id = o.channel_id
        WHERE o.state = 'cancelled' AND o.last_actor = 'S' AND o.settled_at > clock_timestamp() - interval '7 days'
          AND c.connection_state <> 'connected' AND c.reconnect_deadline <= o.settled_at
          AND p.author_kind = 'user'
          AND EXISTS (SELECT 1 FROM app.workspace_members AS m WHERE m.workspace_id = p.workspace_id
            AND m.user_id = p.author_id AND m.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM app.notifications AS n WHERE n.workspace_id = v.workspace_id
            AND n.kind = 'drafts_day_30' AND n.subject_id = v.post_id AND n.level = '30d')
        ORDER BY v.workspace_id, v.post_id, o.settled_at) AS d
      ORDER BY d.settled_at, d.post_id LIMIT p_limit;

  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.notice_create(uuid, uuid, text, uuid, text, jsonb), app.notice_candidates(integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notice_create(uuid, uuid, text, uuid, text, jsonb), app.notice_candidates(integer)
  TO shoutory_worker;

-- The definers that earlier files redefined state their rights again.
REVOKE ALL ON FUNCTION app.operation_insert(uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_operations(text, integer, text), app.admit_due_targets(integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_operations(text, integer, text), app.admit_due_targets(integer, jsonb)
  TO shoutory_worker;
REVOKE ALL ON FUNCTION app.post_delete(uuid, uuid, uuid, uuid[], jsonb, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.post_delete(uuid, uuid, uuid, uuid[], jsonb, text, bytea) TO shoutory_app;

RESET ROLE;
