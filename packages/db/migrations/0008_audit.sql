-- Template A: a workspace row is readable inside the session's read set, and nothing else is granted: there is no
-- insert, update or delete policy for a runtime role, so every row comes from a definer function. A row with no
-- workspace matches no read set and is invisible to every runtime role.
CREATE OR REPLACE FUNCTION app.apply_rls_template(tbl regclass, template text, key_col text DEFAULT 'workspace_id')
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  read_set constant text := format('%I = ANY ((SELECT app.ws_ids())::uuid[])', key_col);
  write_set constant text := format('%I = (SELECT app.write_ws()) AND ', key_col) || read_set;
  builtin_set constant text := format('%I IS NULL AND cardinality((SELECT app.ws_ids())) > 0', key_col);
BEGIN
  IF template IS NULL OR template NOT IN ('W', 'W_builtin', 'O', 'U', 'I', 'D', 'A') THEN
    RAISE EXCEPTION 'unknown template %', template USING ERRCODE = '22023';
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  IF template = 'U' THEN
    EXECUTE format(
      'CREATE POLICY u_select ON %s FOR SELECT TO shoutory_app, shoutory_worker '
      || 'USING (%I = (SELECT app.principal_id()) AND (SELECT app.principal_kind()) = ''user'')',
      tbl, key_col);
  ELSIF template = 'O' THEN
    EXECUTE format(
      'CREATE POLICY o_select ON %s FOR SELECT TO shoutory_app, shoutory_worker USING (%I = (SELECT app.org()))',
      tbl, key_col);
  ELSIF template IN ('W', 'W_builtin', 'A') THEN
    EXECUTE format(
      'CREATE POLICY w_select ON %s FOR SELECT TO shoutory_app, shoutory_worker USING (%s)',
      tbl, CASE WHEN template = 'W_builtin' THEN format('(%s) OR (%s)', read_set, builtin_set) ELSE read_set END);
  END IF;
  IF template IN ('W', 'W_builtin') THEN
    EXECUTE format('CREATE POLICY w_insert ON %s FOR INSERT TO shoutory_app, shoutory_worker WITH CHECK (%s)', tbl, write_set);
    EXECUTE format(
      'CREATE POLICY w_update ON %s FOR UPDATE TO shoutory_app, shoutory_worker USING (%s) WITH CHECK (%s)',
      tbl, write_set, write_set);
    EXECUTE format('CREATE POLICY w_delete ON %s FOR DELETE TO shoutory_app, shoutory_worker USING (%s)', tbl, write_set);
  END IF;
  IF template IN ('W', 'W_builtin', 'O', 'A') THEN
    EXECUTE format(
      'CREATE POLICY portal_restrictive ON %s AS RESTRICTIVE FOR ALL TO shoutory_app, shoutory_worker '
      || 'USING ((SELECT app.principal_kind()) <> ''portal'')',
      tbl);
  END IF;
END
$$;

REVOKE ALL ON FUNCTION app.apply_rls_template(regclass, text, text) FROM PUBLIC;

-- The key is (at, id): a unique key on a partitioned table must contain the partition key. A foreign key
-- to the workspace would block erasure of a workspace, so there is none; the workspace is a plain column.
CREATE TABLE app.audit_logs (
  id uuid NOT NULL DEFAULT uuidv7(),
  at timestamptz NOT NULL,
  workspace_id uuid,
  organization_id uuid,
  actor_kind text NOT NULL CHECK (char_length(actor_kind) BETWEEN 1 AND 32),
  actor_ref text NOT NULL CHECK (char_length(actor_ref) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action ~ '^[a-z]+(\.[a-z_]+)+$' AND char_length(action) <= 64),
  resource_kind text NOT NULL CHECK (char_length(resource_kind) BETWEEN 1 AND 64),
  resource_id text NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 128),
  request_id text CHECK (char_length(request_id) <= 128),
  ip_hmac bytea CHECK (octet_length(ip_hmac) <= 64),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (octet_length(metadata::text) <= 16384),
  prev_hash bytea NOT NULL CHECK (octet_length(prev_hash) = 32),
  hash bytea NOT NULL CHECK (octet_length(hash) = 32),
  PRIMARY KEY (at, id)
) PARTITION BY RANGE (at);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX audit_logs_workspace_at_idx ON app.audit_logs (workspace_id, at DESC);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX audit_logs_resource_idx ON app.audit_logs (resource_kind, resource_id, at);

-- One head row per workspace and UTC day; the rows with no workspace are the instance chain.
CREATE TABLE app.audit_heads (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid,
  day date NOT NULL,
  head_hash bytea NOT NULL CHECK (octet_length(head_hash) = 32),
  CONSTRAINT audit_heads_workspace_day_key UNIQUE NULLS NOT DISTINCT (workspace_id, day)
);

-- ENABLE ALWAYS keeps session_replication_role = replica from skipping the triggers. Dropping a whole partition
-- stays possible for retention.
CREATE FUNCTION app.audit_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'app.audit_logs is insert-only (% refused)', TG_OP USING ERRCODE = '55000';
END
$$;
REVOKE ALL ON FUNCTION app.audit_immutable() FROM PUBLIC;

CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON app.audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.audit_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON app.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_immutable();

SELECT app.apply_rls_template('app.audit_logs'::regclass, 'A');
SELECT app.apply_rls_template('app.audit_heads'::regclass, 'I');
GRANT SELECT ON app.audit_logs TO shoutory_app;

CREATE POLICY audit_append_insert ON app.audit_logs FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'audit_append');
CREATE POLICY audit_append_select ON app.audit_heads FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'audit_append');
CREATE POLICY audit_append_insert ON app.audit_heads FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'audit_append');
CREATE POLICY audit_append_update ON app.audit_heads FOR UPDATE TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'audit_append') WITH CHECK ((SELECT app.job_purpose()) = 'audit_append');

-- No DEFAULT partition. Ownership passes to the definer role last, after everything that needs the migration owner.
DO $$
DECLARE
  first_month constant date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  month date;
  leaf text;
  leaves text[] := ARRAY[]::text[];
BEGIN
  FOR n IN 0..2 LOOP
    month := first_month + make_interval(months => n);
    leaf := format('audit_logs_%s', to_char(month, 'YYYY_MM'));
    EXECUTE format(
      'CREATE TABLE app.%I PARTITION OF app.audit_logs FOR VALUES FROM (%L) TO (%L)',
      leaf, (month::timestamp AT TIME ZONE 'UTC')::text, ((month + interval '1 month')::timestamp AT TIME ZONE 'UTC')::text);
    EXECUTE format(
      'CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.audit_immutable()',
      leaf);
    EXECUTE format('ALTER TABLE app.%I ENABLE ALWAYS TRIGGER audit_logs_immutable', leaf);
    EXECUTE format('ALTER TABLE app.%I ENABLE ALWAYS TRIGGER audit_logs_no_truncate', leaf);
    leaves := leaves || leaf;
  END LOOP;
  ALTER TABLE app.audit_logs ENABLE ALWAYS TRIGGER audit_logs_immutable;
  ALTER TABLE app.audit_logs ENABLE ALWAYS TRIGGER audit_logs_no_truncate;
  FOREACH leaf IN ARRAY leaves LOOP
    EXECUTE format('ALTER TABLE app.%I OWNER TO shoutory_definer', leaf);
  END LOOP;
  ALTER TABLE app.audit_logs OWNER TO shoutory_definer;
  ALTER TABLE app.audit_heads OWNER TO shoutory_definer;
END
$$;

-- Takes the chain's head row FOR UPDATE (the last lock a transaction takes), then reads the clock, so the order
-- of `at` inside a chain is the order of the chain. If the UTC day moved in between, the new day's head is locked
-- and the clock read again: a row's day is always the UTC day of its `at`. The genesis hash is 32 zero bytes.
-- Internal: no runtime role may execute it; the other definers call it.
CREATE FUNCTION app.audit_append(
  workspace_id uuid, organization_id uuid, actor_kind text, actor_ref text, action text, resource_kind text,
  resource_id text, request_id text, ip_hmac bytea, metadata jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  chain_day date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  stamp timestamptz;
  head_id uuid;
  previous bytea;
  new_id constant uuid := uuidv7();
  new_hash bytea;
BEGIN
  PERFORM set_config('app.job_purpose', 'audit_append', true);
  LOOP
    INSERT INTO app.audit_heads (workspace_id, day, head_hash)
      VALUES (audit_append.workspace_id, chain_day, decode(repeat('00', 32), 'hex'))
      ON CONFLICT ON CONSTRAINT audit_heads_workspace_day_key DO NOTHING;
    SELECT h.id, h.head_hash INTO head_id, previous FROM app.audit_heads AS h
      WHERE h.workspace_id IS NOT DISTINCT FROM audit_append.workspace_id AND h.day = chain_day FOR UPDATE;
    stamp := clock_timestamp();
    EXIT WHEN (stamp AT TIME ZONE 'UTC')::date = chain_day;
    chain_day := (stamp AT TIME ZONE 'UTC')::date;
  END LOOP;
  new_hash := sha256(previous || convert_to(jsonb_build_array(
    new_id, audit_append.workspace_id, audit_append.organization_id, (extract(epoch FROM stamp) * 1000000)::bigint,
    audit_append.actor_kind, audit_append.actor_ref, audit_append.action, audit_append.resource_kind,
    audit_append.resource_id, audit_append.request_id, encode(audit_append.ip_hmac, 'hex'),
    audit_append.metadata)::text, 'UTF8'));
  INSERT INTO app.audit_logs (id, at, workspace_id, organization_id, actor_kind, actor_ref, action, resource_kind,
    resource_id, request_id, ip_hmac, metadata, prev_hash, hash)
    VALUES (new_id, stamp, audit_append.workspace_id, audit_append.organization_id, audit_append.actor_kind,
      audit_append.actor_ref, audit_append.action, audit_append.resource_kind, audit_append.resource_id,
      audit_append.request_id, audit_append.ip_hmac, audit_append.metadata, previous, new_hash);
  UPDATE app.audit_heads SET head_hash = new_hash WHERE id = head_id;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- The workspace, organization and actor come from the caller's context, never from an argument, so a caller
-- cannot write a row for a workspace it does not hold or in another actor's name.
CREATE FUNCTION app.audit_insert(
  action text, resource_kind text, resource_id text, request_id text, ip_hmac bytea, metadata jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  workspace constant uuid := app.write_ws();
  organization constant uuid := app.org();
  kind constant text := app.principal_kind();
  principal constant uuid := app.principal_id();
BEGIN
  IF workspace IS NULL OR NOT (workspace = ANY (app.ws_ids())) OR organization IS NULL OR kind IS NULL
     OR principal IS NULL THEN
    RAISE EXCEPTION 'audit_insert refuses this caller' USING ERRCODE = '42501';
  END IF;
  PERFORM app.audit_append(workspace, organization, kind, principal::text, audit_insert.action,
    audit_insert.resource_kind, audit_insert.resource_id, audit_insert.request_id, audit_insert.ip_hmac,
    coalesce(audit_insert.metadata, '{}'));
END
$$;

-- An event with no workspace (a sign-in). The auth role names the actor, who is also the resource.
CREATE FUNCTION app.audit_insert_instance(
  action text, actor_kind text, actor_ref text, request_id text, ip_hmac bytea, metadata jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM app.audit_append(NULL, NULL, audit_insert_instance.actor_kind, audit_insert_instance.actor_ref,
    audit_insert_instance.action, audit_insert_instance.actor_kind, audit_insert_instance.actor_ref,
    audit_insert_instance.request_id, audit_insert_instance.ip_hmac, coalesce(audit_insert_instance.metadata, '{}'));
END
$$;

REVOKE ALL ON FUNCTION app.audit_append(uuid, uuid, text, text, text, text, text, text, bytea, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.audit_insert(text, text, text, text, bytea, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.audit_insert_instance(text, text, text, text, bytea, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audit_insert(text, text, text, text, bytea, jsonb) TO shoutory_app, shoutory_worker;
GRANT EXECUTE ON FUNCTION app.audit_insert_instance(text, text, text, text, bytea, jsonb) TO shoutory_auth;
ALTER FUNCTION app.audit_immutable() OWNER TO shoutory_definer;
ALTER FUNCTION app.audit_append(uuid, uuid, text, text, text, text, text, text, bytea, jsonb) OWNER TO shoutory_definer;
ALTER FUNCTION app.audit_insert(text, text, text, text, bytea, jsonb) OWNER TO shoutory_definer;
ALTER FUNCTION app.audit_insert_instance(text, text, text, text, bytea, jsonb) OWNER TO shoutory_definer;
