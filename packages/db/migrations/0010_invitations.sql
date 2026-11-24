-- Every function here reads the caller from the session context, never from an argument. A workspace the caller
-- cannot reach, a missing one and an unknown id give the same 42501 message per function; a reachable caller below
-- the needed rank gets SH403, a state conflict SH409, an invitation that has ended SH410.
-- Each function locks the organization row, then the workspace row (FOR NO KEY UPDATE) before it reads anything
-- else, so counts, caps and the one-Owner rule hold under concurrent callers. The definer role holds UPDATE on the
-- id column of both tables only to take that lock: an UPDATE policy per purpose passes the lock and refuses every
-- real update (WITH CHECK false).

CREATE TABLE app.invitations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  role_id uuid NOT NULL REFERENCES app.roles (id),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES auth."user" (id),
  revoked_at timestamptz,
  invited_by uuid NOT NULL REFERENCES auth."user" (id),
  CONSTRAINT invitations_workspace_token_key UNIQUE (workspace_id, token_hash)
);
-- shoutory:accepted-lock new empty table in this file
CREATE UNIQUE INDEX invitations_pending_email_key ON app.invitations (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX invitations_token_hash_idx ON app.invitations (token_hash);
SELECT app.apply_rls_template('app.invitations'::regclass, 'W');
-- The runtime role cannot read the token digest.
GRANT SELECT (id, workspace_id, email, role_id, expires_at, accepted_at, accepted_by, revoked_at, invited_by)
  ON app.invitations TO shoutory_app;
GRANT SELECT, INSERT, UPDATE ON app.invitations TO shoutory_definer;
GRANT UPDATE (id) ON app.organizations, app.workspaces TO shoutory_definer;

CREATE PROCEDURE app.grant_purposes(tbl text, cmd text, purposes text[])
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  p text;
  test constant text := '(SELECT app.job_purpose()) = %L';
BEGIN
  FOREACH p IN ARRAY purposes LOOP
    EXECUTE format('CREATE POLICY %I ON app.%I FOR %s TO shoutory_definer %s', p || '_' || lower(cmd), tbl, cmd,
      CASE cmd
        WHEN 'INSERT' THEN format('WITH CHECK (' || test || ')', p)
        WHEN 'UPDATE' THEN format('USING (' || test || ') WITH CHECK (' || CASE WHEN tbl IN ('organizations', 'workspaces')
          THEN 'false' ELSE test END || ')', p, p)
        ELSE format('USING (' || test || ')', p)
      END);
  END LOOP;
END
$$;

-- The rank is the higher of the stored active role and the implicit admin of an organization Owner or Admin,
-- as resolve_workspace_access reads it; 0 reaches nothing. No runtime role may call these helpers.
CREATE FUNCTION app.role_weight(key text)
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE key WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'editor' THEN 3 WHEN 'approver' THEN 2
    WHEN 'viewer' THEN 1 ELSE 0 END
$$;

CREATE FUNCTION app.tenancy_rank(ws uuid, who uuid)
RETURNS integer
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT greatest(
    coalesce((SELECT app.role_weight(ro.key) FROM app.workspace_members AS m JOIN app.roles AS ro ON ro.id = m.role_id
              WHERE m.workspace_id = ws AND m.user_id = who AND m.status = 'active' AND ro.workspace_id IS NULL), 0),
    CASE WHEN EXISTS (SELECT 1 FROM app.workspaces AS w
                      JOIN app.organization_members AS om ON om.organization_id = w.organization_id
                      WHERE w.id = ws AND om.user_id = who AND om.org_role IN ('owner', 'admin')) THEN 4 ELSE 0 END)
$$;

-- Lock order: the organization row, then the workspace row. FOR NO KEY UPDATE blocks another taker of the same
-- locks but not the foreign-key check of a concurrent insert.
CREATE FUNCTION app.tenancy_lock(ws uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  org uuid;
BEGIN
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = ws;
  PERFORM 1 FROM app.organizations AS o WHERE o.id = org FOR NO KEY UPDATE;
  PERFORM 1 FROM app.workspaces AS w WHERE w.id = ws FOR NO KEY UPDATE;
END
$$;

-- The rank is read again under the locks, so a concurrent change cannot slip past the check.
CREATE FUNCTION app.tenancy_enter(fname text, ws uuid, caller uuid, need integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  have integer := app.tenancy_rank(ws, caller);
BEGIN
  IF have = 0 THEN RAISE EXCEPTION '%: refused', fname USING ERRCODE = '42501'; END IF;
  PERFORM app.tenancy_lock(ws);
  have := app.tenancy_rank(ws, caller);
  IF have = 0 THEN RAISE EXCEPTION '%: refused', fname USING ERRCODE = '42501'; END IF;
  IF have < need THEN RAISE EXCEPTION '%: rank too low', fname USING ERRCODE = 'SH403'; END IF;
  RETURN have;
END
$$;

REVOKE ALL ON FUNCTION app.role_weight(text), app.tenancy_rank(uuid, uuid), app.tenancy_lock(uuid),
  app.tenancy_enter(text, uuid, uuid, integer) FROM PUBLIC;
ALTER FUNCTION app.role_weight(text) OWNER TO shoutory_definer;
ALTER FUNCTION app.tenancy_rank(uuid, uuid) OWNER TO shoutory_definer;
ALTER FUNCTION app.tenancy_lock(uuid) OWNER TO shoutory_definer;
ALTER FUNCTION app.tenancy_enter(text, uuid, uuid, integer) OWNER TO shoutory_definer;

CALL app.grant_purposes('organizations', 'SELECT', ARRAY['invitation_create', 'invitation_revoke']);
CALL app.grant_purposes('organizations', 'UPDATE', ARRAY['invitation_create', 'invitation_revoke']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['invitation_create', 'invitation_revoke']);
CALL app.grant_purposes('workspaces', 'UPDATE', ARRAY['invitation_create', 'invitation_revoke']);
CALL app.grant_purposes('workspace_members', 'SELECT', ARRAY['invitation_create', 'invitation_revoke']);
CALL app.grant_purposes('organization_members', 'SELECT', ARRAY['invitation_create', 'invitation_revoke']);
CALL app.grant_purposes('roles', 'SELECT', ARRAY['invitation_create', 'invitation_revoke']);
CALL app.grant_purposes('invitations', 'SELECT', ARRAY['invitation_create', 'invitation_revoke']);
CALL app.grant_purposes('invitations', 'INSERT', ARRAY['invitation_create']);
CALL app.grant_purposes('invitations', 'UPDATE', ARRAY['invitation_create', 'invitation_revoke']);

-- At most the caller's own rank, never owner; at most 100 unexpired pending rows per workspace (53400). An expired
-- pending row of the same address is revoked first; an unexpired one is a conflict (SH409).
CREATE FUNCTION app.invitation_create(
  workspace_id uuid, email text, role_key text, expires_in interval, token_digest bytea, request_id text,
  ip_hmac bytea)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  mail constant text := lower(invitation_create.email);
  span constant interval := coalesce(invitation_create.expires_in, interval '48 hours');
  new_id constant uuid := uuidv7();
  c_rank integer;
  want record;
  org uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'invitation_create', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'invitation_create: refused' USING ERRCODE = '42501';
  END IF;
  c_rank := app.tenancy_enter('invitation_create', invitation_create.workspace_id, caller, 4);
  SELECT r.id, app.role_weight(r.key) AS weight INTO want
    FROM app.roles AS r WHERE r.workspace_id IS NULL AND r.key = invitation_create.role_key;
  IF want.id IS NULL THEN RAISE EXCEPTION 'invitation_create: refused' USING ERRCODE = '42501'; END IF;
  IF invitation_create.role_key = 'owner' OR want.weight > c_rank THEN
    RAISE EXCEPTION 'invitation_create: role above the inviter' USING ERRCODE = 'SH403';
  END IF;
  IF span NOT BETWEEN interval '1 hour' AND interval '14 days' OR mail !~ '^[^@[:space:]]+@[^@[:space:]]+$'
     OR char_length(mail) > 254 OR octet_length(invitation_create.token_digest) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'invitation_create: expires_in, email or token_digest out of range' USING ERRCODE = '22023';
  END IF;
  UPDATE app.invitations AS i SET revoked_at = now()
    WHERE i.workspace_id = invitation_create.workspace_id AND i.email = mail AND i.accepted_at IS NULL
      AND i.revoked_at IS NULL AND i.expires_at <= now();
  IF EXISTS (SELECT 1 FROM app.invitations AS i WHERE i.workspace_id = invitation_create.workspace_id
             AND i.email = mail AND i.accepted_at IS NULL AND i.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'invitation_create: pending_duplicate' USING ERRCODE = 'SH409';
  END IF;
  IF (SELECT count(*) FROM app.invitations AS i WHERE i.workspace_id = invitation_create.workspace_id
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) >= 100 THEN
    RAISE EXCEPTION 'invitation_create: at most 100 pending invitations' USING ERRCODE = '53400';
  END IF;
  INSERT INTO app.invitations (id, workspace_id, email, role_id, token_hash, expires_at, invited_by)
    VALUES (new_id, invitation_create.workspace_id, mail, want.id, invitation_create.token_digest, now() + span, caller);
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = invitation_create.workspace_id;
  PERFORM app.audit_append(invitation_create.workspace_id, org, 'user', caller::text, 'invitation.created',
    'invitation', new_id::text, invitation_create.request_id, invitation_create.ip_hmac,
    jsonb_build_object('role', invitation_create.role_key));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;

CREATE FUNCTION app.invitation_revoke(workspace_id uuid, invitation_id uuid, request_id text, ip_hmac bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  found_row record;
  org uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'invitation_revoke', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'invitation_revoke: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM app.tenancy_enter('invitation_revoke', invitation_revoke.workspace_id, caller, 4);
  SELECT i.accepted_at, i.revoked_at INTO found_row FROM app.invitations AS i
    WHERE i.id = invitation_revoke.invitation_id AND i.workspace_id = invitation_revoke.workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_revoke: refused' USING ERRCODE = '42501'; END IF;
  IF found_row.accepted_at IS NOT NULL OR found_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation_revoke: already_ended' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.invitations AS i SET revoked_at = now() WHERE i.id = invitation_revoke.invitation_id;
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = invitation_revoke.workspace_id;
  PERFORM app.audit_append(invitation_revoke.workspace_id, org, 'user', caller::text, 'invitation.revoked',
    'invitation', invitation_revoke.invitation_id::text, invitation_revoke.request_id, invitation_revoke.ip_hmac,
    '{}');
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.invitation_create(uuid, text, text, interval, bytea, text, bytea),
  app.invitation_revoke(uuid, uuid, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_create(uuid, text, text, interval, bytea, text, bytea),
  app.invitation_revoke(uuid, uuid, text, bytea) TO shoutory_app;
ALTER FUNCTION app.invitation_create(uuid, text, text, interval, bytea, text, bytea) OWNER TO shoutory_definer;
ALTER FUNCTION app.invitation_revoke(uuid, uuid, text, bytea) OWNER TO shoutory_definer;

GRANT UPDATE (role_id) ON app.workspace_members TO shoutory_definer;
GRANT DELETE ON app.workspace_members TO shoutory_definer;
CALL app.grant_purposes('organizations', 'SELECT', ARRAY['member_role_set', 'member_remove']);
CALL app.grant_purposes('organizations', 'UPDATE', ARRAY['member_role_set', 'member_remove']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['member_role_set', 'member_remove', 'workspace_owner_guard']);
CALL app.grant_purposes('workspaces', 'UPDATE', ARRAY['member_role_set', 'member_remove']);
CALL app.grant_purposes('workspace_members', 'SELECT',
  ARRAY['member_role_set', 'member_remove', 'workspace_owner_guard']);
CALL app.grant_purposes('workspace_members', 'UPDATE', ARRAY['member_role_set']);
CALL app.grant_purposes('workspace_members', 'DELETE', ARRAY['member_remove']);
CALL app.grant_purposes('organization_members', 'SELECT', ARRAY['member_role_set', 'member_remove']);
CALL app.grant_purposes('roles', 'SELECT', ARRAY['member_role_set', 'member_remove', 'workspace_owner_guard']);

-- Exactly one stored Owner, whatever the status of the row. The check runs at commit, so one transaction may hand
-- ownership over; a workspace that no longer exists passes. The definers refuse first, so a caller never sees this error.
CREATE FUNCTION app.workspace_owner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  spaces constant uuid[] := CASE TG_OP
    WHEN 'DELETE' THEN ARRAY[OLD.workspace_id]
    WHEN 'INSERT' THEN ARRAY[NEW.workspace_id]
    ELSE ARRAY[OLD.workspace_id, NEW.workspace_id] END;
  bad uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'workspace_owner_guard', true);
  SELECT g.id INTO bad FROM unnest(spaces) AS g (id)
    WHERE EXISTS (SELECT 1 FROM app.workspaces AS w WHERE w.id = g.id)
      AND (SELECT count(*) FROM app.workspace_members AS m JOIN app.roles AS r ON r.id = m.role_id
           WHERE m.workspace_id = g.id AND r.workspace_id IS NULL AND r.key = 'owner') <> 1
    LIMIT 1;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'workspace % must have exactly one owner', bad USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER workspace_owner_guard
  AFTER INSERT OR UPDATE OF role_id, workspace_id OR DELETE ON app.workspace_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.workspace_owner_guard();
REVOKE ALL ON FUNCTION app.workspace_owner_guard() FROM PUBLIC;
ALTER FUNCTION app.workspace_owner_guard() OWNER TO shoutory_definer;

-- The caller may change only a member strictly below them (stored or implicit rank on both sides) to a role at most
-- their own. Ownership moves only here: the stored Owner makes an active member the Owner and becomes admin in the
-- same transaction (SH403 for anyone else); the Owner demoting themself is SH409.
CREATE FUNCTION app.member_role_set(workspace_id uuid, user_id uuid, role_key text, request_id text, ip_hmac bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  c_rank integer;
  want uuid;
  target record;
  own_key text;
  org uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'member_role_set', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'member_role_set: refused' USING ERRCODE = '42501';
  END IF;
  c_rank := app.tenancy_enter('member_role_set', member_role_set.workspace_id, caller, 4);
  SELECT r.id INTO want FROM app.roles AS r WHERE r.workspace_id IS NULL AND r.key = member_role_set.role_key;
  SELECT m.id, ro.key, m.status INTO target FROM app.workspace_members AS m JOIN app.roles AS ro ON ro.id = m.role_id
    WHERE m.workspace_id = member_role_set.workspace_id AND m.user_id = member_role_set.user_id;
  IF want IS NULL OR target.id IS NULL THEN RAISE EXCEPTION 'member_role_set: refused' USING ERRCODE = '42501'; END IF;
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = member_role_set.workspace_id;
  IF target.key = 'owner' AND member_role_set.user_id <> caller AND member_role_set.role_key <> 'owner' THEN
    RAISE EXCEPTION 'member_role_set: the Owner is not changed here' USING ERRCODE = 'SH403';
  ELSIF target.status <> 'active' THEN
    RAISE EXCEPTION 'member_role_set: refused' USING ERRCODE = '42501';
  END IF;
  IF member_role_set.role_key = 'owner' THEN
    SELECT ro.key INTO own_key FROM app.workspace_members AS m JOIN app.roles AS ro ON ro.id = m.role_id
      WHERE m.workspace_id = member_role_set.workspace_id AND m.user_id = caller AND m.status = 'active'
        AND ro.workspace_id IS NULL;
    IF own_key IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'member_role_set: only the Owner transfers ownership' USING ERRCODE = 'SH403';
    END IF;
    IF member_role_set.user_id = caller THEN
      RAISE EXCEPTION 'member_role_set: already_owner' USING ERRCODE = 'SH409';
    END IF;
    UPDATE app.workspace_members AS m SET role_id = want WHERE m.id = target.id;
    UPDATE app.workspace_members AS m
      SET role_id = (SELECT r.id FROM app.roles AS r WHERE r.workspace_id IS NULL AND r.key = 'admin')
      WHERE m.workspace_id = member_role_set.workspace_id AND m.user_id = caller;
  ELSE
    IF target.key = 'owner' AND member_role_set.user_id = caller THEN
      RAISE EXCEPTION 'member_role_set: last_owner' USING ERRCODE = 'SH409';
    END IF;
    IF app.tenancy_rank(member_role_set.workspace_id, member_role_set.user_id) >= c_rank
       OR app.role_weight(member_role_set.role_key) > c_rank THEN
      RAISE EXCEPTION 'member_role_set: rank too low' USING ERRCODE = 'SH403';
    END IF;
    UPDATE app.workspace_members AS m SET role_id = want WHERE m.id = target.id;
  END IF;
  PERFORM app.audit_append(member_role_set.workspace_id, org, 'user', caller::text,
    CASE member_role_set.role_key WHEN 'owner' THEN 'workspace.owner_transferred' ELSE 'member.role_changed' END,
    'member', member_role_set.user_id::text, member_role_set.request_id, member_role_set.ip_hmac,
    jsonb_build_object('from', target.key, 'to', member_role_set.role_key));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- A member may leave at any rank except the Owner; an implicit admin has no stored row to leave. Removing another
-- member needs a member strictly below the caller.
CREATE FUNCTION app.member_remove(workspace_id uuid, user_id uuid, request_id text, ip_hmac bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  leaving constant boolean := member_remove.user_id = caller;
  c_rank integer;
  target record;
  org uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'member_remove', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'member_remove: refused' USING ERRCODE = '42501';
  END IF;
  c_rank := app.tenancy_enter('member_remove', member_remove.workspace_id, caller, CASE WHEN leaving THEN 1 ELSE 4 END);
  SELECT m.id, ro.key INTO target FROM app.workspace_members AS m JOIN app.roles AS ro ON ro.id = m.role_id
    WHERE m.workspace_id = member_remove.workspace_id AND m.user_id = member_remove.user_id;
  IF target.id IS NULL AND leaving THEN
    RAISE EXCEPTION 'member_remove: not a stored member' USING ERRCODE = 'SH403';
  ELSIF target.id IS NULL THEN
    RAISE EXCEPTION 'member_remove: refused' USING ERRCODE = '42501';
  END IF;
  IF target.key = 'owner' AND leaving THEN
    RAISE EXCEPTION 'member_remove: last_owner' USING ERRCODE = 'SH409';
  ELSIF target.key = 'owner' THEN
    RAISE EXCEPTION 'member_remove: the Owner is not removed here' USING ERRCODE = 'SH403';
  END IF;
  IF NOT leaving AND app.tenancy_rank(member_remove.workspace_id, member_remove.user_id) >= c_rank THEN
    RAISE EXCEPTION 'member_remove: rank too low' USING ERRCODE = 'SH403';
  END IF;
  DELETE FROM app.workspace_members AS m WHERE m.id = target.id;
  SELECT w.organization_id INTO org FROM app.workspaces AS w WHERE w.id = member_remove.workspace_id;
  PERFORM app.audit_append(member_remove.workspace_id, org, 'user', caller::text,
    CASE WHEN leaving THEN 'member.left' ELSE 'member.removed' END, 'member', member_remove.user_id::text,
    member_remove.request_id, member_remove.ip_hmac, jsonb_build_object('role', target.key));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.member_role_set(uuid, uuid, text, text, bytea),
  app.member_remove(uuid, uuid, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.member_role_set(uuid, uuid, text, text, bytea),
  app.member_remove(uuid, uuid, text, bytea) TO shoutory_app;
ALTER FUNCTION app.member_role_set(uuid, uuid, text, text, bytea) OWNER TO shoutory_definer;
ALTER FUNCTION app.member_remove(uuid, uuid, text, bytea) OWNER TO shoutory_definer;

GRANT SELECT (email) ON auth."user" TO shoutory_definer;
CALL app.grant_purposes('organizations', 'SELECT', ARRAY['invitation_accept']);
CALL app.grant_purposes('organizations', 'UPDATE', ARRAY['invitation_accept']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['invitation_accept']);
CALL app.grant_purposes('workspaces', 'UPDATE', ARRAY['invitation_accept']);
CALL app.grant_purposes('workspace_members', 'SELECT', ARRAY['invitation_accept']);
CALL app.grant_purposes('workspace_members', 'INSERT', ARRAY['invitation_accept']);
CALL app.grant_purposes('organization_members', 'SELECT', ARRAY['invitation_accept']);
CALL app.grant_purposes('roles', 'SELECT', ARRAY['invitation_accept']);
CALL app.grant_purposes('invitations', 'SELECT', ARRAY['invitation_accept']);
CALL app.grant_purposes('invitations', 'UPDATE', ARRAY['invitation_accept']);

-- The checks run in this order so another account learns nothing about a row: no row for the digest (or two), or a
-- role that is owner or not built in: 42501, one message for all; a different address: SH403 email_mismatch
-- whatever the state of the row; an unverified address: SH403 email_unverified; only then, to the invited account,
-- a used, revoked, expired or inviter-lost-rights row (reads as revoked): SH410; an existing membership: SH409.
-- The row is consumed by a conditional UPDATE under the workspace lock, so two concurrent accepts add one member.
CREATE FUNCTION app.invitation_accept(token_digest bytea, request_id text, ip_hmac bytea)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  inv record;
  me record;
  st record;
  reason text;
  consumed integer;
BEGIN
  PERFORM set_config('app.job_purpose', 'invitation_accept', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'invitation_accept: refused' USING ERRCODE = '42501';
  END IF;
  SELECT i.id, i.workspace_id AS ws, i.email, i.invited_by, ro.id AS role_id, ro.key, ro.workspace_id AS role_ws
    INTO inv FROM app.invitations AS i JOIN app.roles AS ro ON ro.id = i.role_id
    WHERE i.token_hash = invitation_accept.token_digest;
  IF inv.id IS NULL OR inv.key = 'owner' OR inv.role_ws IS NOT NULL
     OR (SELECT count(*) FROM app.invitations AS i WHERE i.token_hash = invitation_accept.token_digest) <> 1 THEN
    RAISE EXCEPTION 'invitation_accept: refused' USING ERRCODE = '42501';
  END IF;
  SELECT u.email, u.email_verified INTO me FROM auth."user" AS u WHERE u.id = caller;
  IF lower(me.email) IS DISTINCT FROM inv.email THEN
    RAISE EXCEPTION 'invitation_accept: email_mismatch' USING ERRCODE = 'SH403';
  ELSIF NOT me.email_verified THEN
    RAISE EXCEPTION 'invitation_accept: email_unverified' USING ERRCODE = 'SH403';
  END IF;
  PERFORM app.tenancy_lock(inv.ws);
  SELECT i.accepted_at, i.revoked_at, i.expires_at INTO st FROM app.invitations AS i WHERE i.id = inv.id;
  reason := CASE
    WHEN st.accepted_at IS NOT NULL THEN 'used'
    WHEN st.revoked_at IS NOT NULL THEN 'revoked'
    WHEN st.expires_at <= now() THEN 'expired'
    WHEN app.tenancy_rank(inv.ws, inv.invited_by) < greatest(4, app.role_weight(inv.key)) THEN 'revoked' END;
  IF reason IS NOT NULL THEN
    RAISE EXCEPTION 'invitation_accept: %', reason USING ERRCODE = 'SH410',
      DETAIL = format('expires %s; invited by %s', st.expires_at,
                      (SELECT u.name FROM auth."user" AS u WHERE u.id = inv.invited_by));
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_members AS m WHERE m.workspace_id = inv.ws AND m.user_id = caller) THEN
    RAISE EXCEPTION 'invitation_accept: already_member' USING ERRCODE = 'SH409';
  END IF;
  UPDATE app.invitations AS i SET accepted_at = now(), accepted_by = caller
    WHERE i.id = inv.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now();
  GET DIAGNOSTICS consumed = ROW_COUNT;
  IF consumed <> 1 THEN RAISE EXCEPTION 'invitation_accept: used' USING ERRCODE = 'SH410'; END IF;
  INSERT INTO app.workspace_members (workspace_id, user_id, role_id) VALUES (inv.ws, caller, inv.role_id);
  PERFORM app.audit_append(inv.ws, (SELECT w.organization_id FROM app.workspaces AS w WHERE w.id = inv.ws), 'user',
    caller::text, 'invitation.accepted', 'invitation', inv.id::text, invitation_accept.request_id,
    invitation_accept.ip_hmac, jsonb_build_object('role', inv.key));
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN inv.ws;
END
$$;

REVOKE ALL ON FUNCTION app.invitation_accept(bytea, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_accept(bytea, text, bytea) TO shoutory_app;
ALTER FUNCTION app.invitation_accept(bytea, text, bytea) OWNER TO shoutory_definer;

-- The definer role owns the function and the migration owner does not inherit its rights, so the replacement runs
-- as the definer.
SET ROLE shoutory_definer;
CREATE OR REPLACE FUNCTION app.bucket_limits(scope text)
RETURNS TABLE (capacity integer, refill_seconds integer)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT l.capacity, l.refill_seconds FROM (VALUES
    ('login_account', 100, 86400),
    ('login_ip', 60, 900),
    ('verification_resend', 5, 3600),
    ('two_factor', 10, 900),
    ('password_reset', 5, 3600),
    ('totp_code', 1, 90),
    ('link_confirm', 20, 900),
    ('invite', 20, 3600),
    ('invite_accept', 10, 900)
  ) AS l (name, capacity, refill_seconds) WHERE l.name = scope
$$;
REVOKE ALL ON FUNCTION app.bucket_limits(text) FROM PUBLIC;
ALTER FUNCTION app.bucket_limits(text) OWNER TO shoutory_definer;
RESET ROLE;

-- workspace_create takes the organization row lock after the authorization check and counts every workspace row of
-- the organization, archived or not: the 101st is refused (53400), and two callers at 99 admit one.
CALL app.grant_purposes('organizations', 'SELECT', ARRAY['workspace_create']);
CALL app.grant_purposes('organizations', 'UPDATE', ARRAY['workspace_create']);
CALL app.grant_purposes('workspaces', 'SELECT', ARRAY['workspace_create']);
SET ROLE shoutory_definer;
CREATE OR REPLACE FUNCTION app.workspace_create(
  organization_id uuid, name text, slug text, tz text, request_id text, ip_hmac bytea)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
  new_id constant uuid := uuidv7();
  owner_role uuid;
BEGIN
  PERFORM set_config('app.job_purpose', 'workspace_create', true);
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user'
     OR NOT EXISTS (SELECT 1 FROM app.organization_members AS m
                    WHERE m.organization_id = workspace_create.organization_id AND m.user_id = caller
                      AND m.org_role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'workspace_create refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS z WHERE z.name = workspace_create.tz) THEN
    RAISE EXCEPTION 'workspace_create: unknown time zone' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM app.organizations AS o WHERE o.id = workspace_create.organization_id FOR NO KEY UPDATE;
  IF NOT EXISTS (SELECT 1 FROM app.organization_members AS m
                 WHERE m.organization_id = workspace_create.organization_id AND m.user_id = caller
                   AND m.org_role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'workspace_create refuses this caller' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM app.workspaces AS w WHERE w.organization_id = workspace_create.organization_id) >= 100 THEN
    RAISE EXCEPTION 'workspace_create: at most 100 workspaces per organization' USING ERRCODE = '53400';
  END IF;
  SELECT r.id INTO owner_role FROM app.roles AS r WHERE r.workspace_id IS NULL AND r.key = 'owner';
  INSERT INTO app.workspaces (id, organization_id, name, slug, default_tz)
    VALUES (new_id, workspace_create.organization_id, workspace_create.name, workspace_create.slug,
            workspace_create.tz);
  INSERT INTO app.workspace_members (workspace_id, user_id, role_id) VALUES (new_id, caller, owner_role);
  PERFORM app.audit_append(new_id, workspace_create.organization_id, 'user', caller::text, 'workspace.created',
    'workspace', new_id::text, workspace_create.request_id, workspace_create.ip_hmac, '{}');
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN new_id;
END
$$;
REVOKE ALL ON FUNCTION app.workspace_create(uuid, text, text, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspace_create(uuid, text, text, text, text, bytea) TO shoutory_app;
ALTER FUNCTION app.workspace_create(uuid, text, text, text, text, bytea) OWNER TO shoutory_definer;
RESET ROLE;

DROP PROCEDURE app.grant_purposes(text, text, text[]);
