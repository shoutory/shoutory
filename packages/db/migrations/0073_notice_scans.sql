-- What the notice job reads each tick, and the move of an unclear operation's next reminder. A notice that has not been
-- sent is listed once per level; a token or deadline first seen inside a window gets only the smallest level it has
-- crossed, so the larger levels are never sent late.
GRANT UPDATE (next_escalation_at) ON app.operations TO shoutory_definer;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channels', 'channel_credentials', 'operations', 'post_variants', 'posts', 'post_versions',
      'media_assets', 'workspaces', 'notifications'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['notice_candidates']);
  END LOOP;
END
$$;
CALL app.grant_purposes('operations', 'SELECT', ARRAY['notice_escalation_advance']);
CALL app.grant_purposes('operations', 'UPDATE', ARRAY['notice_escalation_advance']);

SET ROLE shoutory_definer;

-- Every candidate carries only the keys the mail copy knows. An operation in needs_human or unverified is due when its
-- next_escalation_at has come; its step is one more than the highest step already written for it.
CREATE FUNCTION app.notice_candidates(p_limit integer)
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
        jsonb_build_object('name', coalesce(c.nickname, c.display_name), 'provider', c.provider_id, 'days', w.days)
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
        jsonb_build_object('name', coalesce(c.nickname, c.display_name), 'provider', c.provider_id, 'days', w.days)
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
        jsonb_build_object('name', coalesce(c.nickname, c.display_name), 'provider', o.provider_id)
          || CASE WHEN o.reason_code IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason', o.reason_code) END
      FROM app.operations AS o
      JOIN app.channels AS c ON c.workspace_id = o.workspace_id AND c.id = o.channel_id
      CROSS JOIN LATERAL (SELECT coalesce(max(substring(n.level FROM 12)::integer) + 1, 0) AS next_step
        FROM app.notifications AS n WHERE n.workspace_id = o.workspace_id AND n.kind = o.state
          AND n.subject_id = o.id AND n.level ~ '^escalation_[0-9]{1,6}$') AS s
      WHERE o.state IN ('needs_human', 'unverified') AND o.next_escalation_at <= clock_timestamp()
      ORDER BY o.next_escalation_at, o.id LIMIT p_limit;

  RETURN QUERY
    SELECT 'held_media'::text, v.workspace_id, v.id, 'held'::text, 0,
        jsonb_build_object('name', coalesce(c.nickname, c.display_name), 'provider', c.provider_id)
      FROM app.post_variants AS v
      JOIN app.workspaces AS w ON w.id = v.workspace_id
      JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
      JOIN app.channels AS c ON c.workspace_id = v.workspace_id AND c.id = v.channel_id
      WHERE w.archived_at IS NULL AND v.schedule_state = 'scheduled' AND v.due_at IS NOT NULL
        AND v.due_at <= clock_timestamp() AND clock_timestamp() <= v.due_at + w.lateness_tolerance
        AND p.deleted_at IS NULL AND p.status <> 'archived' AND v.frozen_version_id IS NOT NULL
        AND app.media_held(v.workspace_id, v.frozen_version_id)
        AND NOT EXISTS (SELECT 1 FROM app.notifications AS n WHERE n.workspace_id = v.workspace_id
          AND n.kind = 'held_media' AND n.subject_id = v.id AND n.level = 'held')
      ORDER BY v.due_at, v.id LIMIT p_limit;

  RETURN QUERY
    SELECT 'drafts_day_30'::text, d.workspace_id, d.post_id, '30d'::text, 0,
        jsonb_build_object('name', d.name, 'provider', d.provider_id, 'days', 30)
      FROM (SELECT DISTINCT ON (v.workspace_id, v.post_id) v.workspace_id, v.post_id, o.settled_at,
          coalesce(c.nickname, c.display_name) AS name, c.provider_id
        FROM app.operations AS o
        JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
        JOIN app.channels AS c ON c.workspace_id = o.workspace_id AND c.id = o.channel_id
        WHERE o.state = 'cancelled' AND o.last_actor = 'S' AND o.settled_at > clock_timestamp() - interval '7 days'
          AND c.connection_state <> 'connected' AND c.reconnect_deadline <= o.settled_at
          AND NOT EXISTS (SELECT 1 FROM app.notifications AS n WHERE n.workspace_id = v.workspace_id
            AND n.kind = 'drafts_day_30' AND n.subject_id = v.post_id AND n.level = '30d')
        ORDER BY v.workspace_id, v.post_id, o.settled_at) AS d
      ORDER BY d.settled_at, d.post_id LIMIT p_limit;

  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Moves the next reminder of an operation that is still unclear and still due, and only then: two callers never move
-- one operation twice. The gaps from the entry are 1 day, then 2, 4, and a week after that.
CREATE FUNCTION app.notice_escalation_advance(p_workspace_id uuid, p_operation_id uuid, p_step integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  written bigint;
BEGIN
  PERFORM app.ledger_caller();
  IF p_step IS NULL OR p_step NOT BETWEEN 0 AND 999999 THEN
    RAISE EXCEPTION 'notice_escalation_advance: the step is not valid' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'notice_escalation_advance', true);
  UPDATE app.operations AS o SET next_escalation_at = clock_timestamp()
      + CASE p_step WHEN 0 THEN interval '1 day' WHEN 1 THEN interval '2 days' WHEN 2 THEN interval '4 days'
        ELSE interval '7 days' END
    WHERE o.workspace_id = p_workspace_id AND o.id = p_operation_id AND o.state IN ('needs_human', 'unverified')
      AND o.next_escalation_at <= clock_timestamp();
  GET DIAGNOSTICS written = ROW_COUNT;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN written = 1;
END
$$;

REVOKE ALL ON FUNCTION app.notice_candidates(integer), app.notice_escalation_advance(uuid, uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notice_candidates(integer), app.notice_escalation_advance(uuid, uuid, integer)
  TO shoutory_worker;

RESET ROLE;
