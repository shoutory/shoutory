-- A person's language for the mail they receive (null reads English), and the table of notices. A notice is unique per
-- workspace, user, kind, subject and level, so a level fires once; only a definer writes it, and its mail row is
-- written in the same transaction only when the notice is new.
ALTER TABLE app.user_profiles ADD COLUMN locale text;
-- shoutory:accepted-lock the column was added by the line above and holds no value yet
ALTER TABLE app.user_profiles ADD CONSTRAINT user_profiles_locale_check CHECK (locale IN ('en', 'ar'));

ALTER TABLE app.channels DROP COLUMN last_reauth_notice;

CREATE TABLE app.notifications (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('token_expiry', 'reconnect_deadline', 'needs_human', 'unverified', 'held_media',
    'drafts_day_30')),
  subject_id uuid NOT NULL,
  level text NOT NULL CHECK (char_length(level) BETWEEN 1 AND 16),
  vars jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(vars) = 'object' AND octet_length(vars::text) <= 2048),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  CONSTRAINT notifications_key UNIQUE (workspace_id, user_id, kind, subject_id, level)
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX notifications_user_idx ON app.notifications (user_id, created_at DESC);
SELECT app.apply_rls_template('app.notifications'::regclass, 'A');
-- A reader sees their own rows only, on top of the workspace read set.
CREATE POLICY notifications_own_rows ON app.notifications AS RESTRICTIVE FOR SELECT TO shoutory_app, shoutory_worker
  USING (user_id = (SELECT app.principal_id()));
GRANT SELECT ON app.notifications TO shoutory_app;
GRANT SELECT, INSERT ON app.notifications TO shoutory_definer;
GRANT SELECT (id) ON auth."user" TO shoutory_definer;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'workspace_members', 'organization_members', 'roles', 'user_profiles'] LOOP
    CALL app.grant_purposes(t, 'SELECT', ARRAY['notice_create', 'notice_recipients']);
  END LOOP;
END
$$;
CALL app.grant_purposes('notifications', 'SELECT', ARRAY['notice_create']);
CALL app.grant_purposes('notifications', 'INSERT', ARRAY['notice_create']);
CALL app.grant_purposes('email_outbox', 'INSERT', ARRAY['notice_create']);
CALL app.grant_purposes('channel_credentials', 'SELECT', ARRAY['notice_recipients']);
CALL app.grant_purposes('posts', 'SELECT', ARRAY['notice_recipients']);
CALL app.grant_purposes('post_variants', 'SELECT', ARRAY['notice_recipients']);
CALL app.grant_purposes('operations', 'SELECT', ARRAY['notice_recipients']);

SET ROLE shoutory_definer;

-- True when the notice is new. Only a new notice writes the mail row, in the same transaction, so a crash neither
-- repeats nor loses a mail. The mail keeps only the few keys the copy knows; anything else the caller passes is dropped.
CREATE FUNCTION app.notice_create(
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
    WHERE e.key IN ('name', 'provider', 'days', 'reason') AND jsonb_typeof(e.value) IN ('string', 'number');
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

-- Token expiry and reconnect deadline: the Owners and Admins of the workspace. A stuck or unclear post: its author and
-- the Owners and Admins. Held media and the day-30 drafts: the author. A subject the workspace does not hold gives no one.
CREATE FUNCTION app.notice_recipients(workspace_id uuid, kind text, subject_id uuid)
RETURNS TABLE (user_id uuid, email text, locale text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  post uuid;
  channel_known boolean := false;
BEGIN
  PERFORM app.ledger_caller();
  PERFORM set_config('app.job_purpose', 'notice_recipients', true);
  IF notice_recipients.kind IS NULL OR notice_recipients.kind NOT IN ('token_expiry', 'reconnect_deadline',
      'needs_human', 'unverified', 'held_media', 'drafts_day_30') THEN
    RAISE EXCEPTION 'notice_recipients: the kind is not known' USING ERRCODE = '22023';
  END IF;
  IF notice_recipients.kind IN ('token_expiry', 'reconnect_deadline') THEN
    SELECT true INTO channel_known FROM app.channel_credentials AS k
      WHERE k.workspace_id = notice_recipients.workspace_id AND k.id = notice_recipients.subject_id;
  ELSIF notice_recipients.kind IN ('needs_human', 'unverified') THEN
    SELECT v.post_id INTO post FROM app.operations AS o
      JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
      WHERE o.workspace_id = notice_recipients.workspace_id AND o.id = notice_recipients.subject_id;
  ELSIF notice_recipients.kind = 'held_media' THEN
    SELECT v.post_id INTO post FROM app.post_variants AS v
      WHERE v.workspace_id = notice_recipients.workspace_id AND v.id = notice_recipients.subject_id;
  ELSE
    post := notice_recipients.subject_id;
  END IF;
  RETURN QUERY
    WITH wanted AS (
      SELECT m.user_id AS who FROM app.workspace_members AS m JOIN app.roles AS r ON r.id = m.role_id
        WHERE m.workspace_id = notice_recipients.workspace_id AND m.status = 'active' AND r.workspace_id IS NULL
          AND r.key IN ('owner', 'admin')
          AND (channel_known OR (post IS NOT NULL AND notice_recipients.kind IN ('needs_human', 'unverified')))
      UNION
      SELECT p.author_id FROM app.posts AS p
        WHERE p.workspace_id = notice_recipients.workspace_id AND p.id = post AND p.author_kind = 'user'
          AND notice_recipients.kind IN ('needs_human', 'unverified', 'held_media', 'drafts_day_30'))
    SELECT u.id, u.email, coalesce(pr.locale, 'en') FROM wanted AS w
      JOIN auth."user" AS u ON u.id = w.who
      JOIN app.workspace_members AS m ON m.workspace_id = notice_recipients.workspace_id AND m.user_id = u.id
        AND m.status = 'active'
      LEFT JOIN app.user_profiles AS pr ON pr.user_id = u.id
      ORDER BY u.id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.notice_create(uuid, uuid, text, uuid, text, jsonb),
  app.notice_recipients(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notice_create(uuid, uuid, text, uuid, text, jsonb),
  app.notice_recipients(uuid, text, uuid) TO shoutory_worker;

RESET ROLE;
