-- A link that signs someone in or resets a password is stored only sealed; the sender sets every sealed column to
-- NULL after it sends and keeps the digest. No runtime role holds a grant on the table: the definers are the only way in.
CREATE TABLE app.email_outbox (
  id uuid PRIMARY KEY,
  workspace_id uuid,
  recipient text NOT NULL,
  template text NOT NULL,
  locale text NOT NULL,
  vars jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  link_ciphertext bytea,
  link_iv bytea,
  link_auth_tag bytea,
  link_wrap_iv bytea,
  link_wrap_tag bytea,
  link_wrapped_dek bytea,
  link_key_id text CHECK (link_key_id ~ '^[a-z0-9-]{1,32}$'),
  link_format_version integer,
  link_generation integer,
  link_digest text CHECK (link_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_outbox_link_whole CHECK (num_nonnulls(link_ciphertext, link_iv, link_auth_tag, link_wrap_iv,
    link_wrap_tag, link_wrapped_dek, link_key_id, link_format_version, link_generation) IN (0, 9))
);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX email_outbox_sealed_key_idx ON app.email_outbox (link_key_id) WHERE link_ciphertext IS NOT NULL;
SELECT app.apply_rls_template('app.email_outbox'::regclass, 'D');
GRANT SELECT, INSERT ON app.email_outbox TO shoutory_definer;
GRANT UPDATE (link_ciphertext, link_iv, link_auth_tag, link_wrap_iv, link_wrap_tag, link_wrapped_dek,
  link_key_id, link_format_version, link_generation) ON app.email_outbox TO shoutory_definer;

CREATE POLICY email_outbox_enqueue_insert ON app.email_outbox FOR INSERT TO shoutory_definer
  WITH CHECK ((SELECT app.job_purpose()) = 'email_outbox_enqueue');
CREATE POLICY sealed_key_ids_select ON app.email_outbox FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'sealed_key_ids');
CREATE POLICY email_outbox_reseal_batch_select ON app.email_outbox FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'email_outbox_reseal_batch');
CREATE POLICY email_outbox_reseal_write_select ON app.email_outbox FOR SELECT TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'email_outbox_reseal_write');
CREATE POLICY email_outbox_reseal_write_update ON app.email_outbox FOR UPDATE TO shoutory_definer
  USING ((SELECT app.job_purpose()) = 'email_outbox_reseal_write')
  WITH CHECK ((SELECT app.job_purpose()) = 'email_outbox_reseal_write');

-- The caller seals with the row id as the AAD owner, so the id comes from the caller.
CREATE FUNCTION app.email_outbox_enqueue(
  id uuid, workspace_id uuid, recipient text, template text, locale text, vars jsonb,
  link_ciphertext bytea, link_iv bytea, link_auth_tag bytea, link_wrap_iv bytea, link_wrap_tag bytea,
  link_wrapped_dek bytea, link_key_id text, link_format_version integer, link_digest text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'email_outbox_enqueue', true);
  INSERT INTO app.email_outbox (id, workspace_id, recipient, template, locale, vars, link_ciphertext, link_iv,
      link_auth_tag, link_wrap_iv, link_wrap_tag, link_wrapped_dek, link_key_id, link_format_version,
      link_generation, link_digest)
    VALUES (email_outbox_enqueue.id, email_outbox_enqueue.workspace_id, email_outbox_enqueue.recipient,
      email_outbox_enqueue.template, email_outbox_enqueue.locale, email_outbox_enqueue.vars,
      email_outbox_enqueue.link_ciphertext, email_outbox_enqueue.link_iv, email_outbox_enqueue.link_auth_tag,
      email_outbox_enqueue.link_wrap_iv, email_outbox_enqueue.link_wrap_tag, email_outbox_enqueue.link_wrapped_dek,
      email_outbox_enqueue.link_key_id, email_outbox_enqueue.link_format_version, 0,
      email_outbox_enqueue.link_digest);
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

CREATE FUNCTION app.sealed_key_ids()
RETURNS TABLE (key_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  PERFORM set_config('app.job_purpose', 'sealed_key_ids', true);
  RETURN QUERY SELECT DISTINCT e.link_key_id FROM app.email_outbox AS e WHERE e.link_ciphertext IS NOT NULL;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

CREATE FUNCTION app.email_outbox_reseal_batch(lim integer, active_key_id text, after_id uuid)
RETURNS TABLE (
  id uuid, workspace_id uuid, link_ciphertext bytea, link_iv bytea, link_auth_tag bytea, link_wrap_iv bytea,
  link_wrap_tag bytea, link_wrapped_dek bytea, link_key_id text, link_format_version integer,
  link_generation integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF lim IS NULL OR lim NOT BETWEEN 1 AND 500 OR email_outbox_reseal_batch.active_key_id IS NULL THEN
    RAISE EXCEPTION 'email_outbox_reseal_batch refuses this limit or key id' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'email_outbox_reseal_batch', true);
  RETURN QUERY
    SELECT e.id, e.workspace_id, e.link_ciphertext, e.link_iv, e.link_auth_tag, e.link_wrap_iv, e.link_wrap_tag,
        e.link_wrapped_dek, e.link_key_id, e.link_format_version, e.link_generation
      FROM app.email_outbox AS e
      WHERE e.link_ciphertext IS NOT NULL AND e.link_key_id <> email_outbox_reseal_batch.active_key_id
        AND (after_id IS NULL OR e.id > after_id)
      ORDER BY e.id LIMIT lim;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

-- Compare-and-set on the generation: false means another writer won.
CREATE FUNCTION app.email_outbox_reseal_write(
  id uuid, expected_generation integer, link_ciphertext bytea, link_iv bytea, link_auth_tag bytea,
  link_wrap_iv bytea, link_wrap_tag bytea, link_wrapped_dek bytea, link_key_id text, link_format_version integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  written bigint;
BEGIN
  PERFORM set_config('app.job_purpose', 'email_outbox_reseal_write', true);
  UPDATE app.email_outbox AS e SET
      link_ciphertext = email_outbox_reseal_write.link_ciphertext, link_iv = email_outbox_reseal_write.link_iv,
      link_auth_tag = email_outbox_reseal_write.link_auth_tag, link_wrap_iv = email_outbox_reseal_write.link_wrap_iv,
      link_wrap_tag = email_outbox_reseal_write.link_wrap_tag,
      link_wrapped_dek = email_outbox_reseal_write.link_wrapped_dek,
      link_key_id = email_outbox_reseal_write.link_key_id,
      link_format_version = email_outbox_reseal_write.link_format_version,
      link_generation = email_outbox_reseal_write.expected_generation + 1
    WHERE e.id = email_outbox_reseal_write.id AND e.link_generation = email_outbox_reseal_write.expected_generation
      AND e.link_ciphertext IS NOT NULL;
  GET DIAGNOSTICS written = ROW_COUNT;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
  RETURN written = 1;
END
$$;

REVOKE ALL ON FUNCTION app.email_outbox_enqueue(uuid, uuid, text, text, text, jsonb, bytea, bytea, bytea, bytea,
  bytea, bytea, text, integer, text), app.sealed_key_ids(), app.email_outbox_reseal_batch(integer, text, uuid),
  app.email_outbox_reseal_write(uuid, integer, bytea, bytea, bytea, bytea, bytea, bytea, text, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_outbox_enqueue(uuid, uuid, text, text, text, jsonb, bytea, bytea, bytea, bytea,
  bytea, bytea, text, integer, text) TO shoutory_auth, shoutory_app;
GRANT EXECUTE ON FUNCTION app.sealed_key_ids() TO shoutory_app, shoutory_worker;
GRANT EXECUTE ON FUNCTION app.email_outbox_reseal_batch(integer, text, uuid),
  app.email_outbox_reseal_write(uuid, integer, bytea, bytea, bytea, bytea, bytea, bytea, text, integer)
  TO shoutory_worker;
ALTER FUNCTION app.email_outbox_enqueue(uuid, uuid, text, text, text, jsonb, bytea, bytea, bytea, bytea,
  bytea, bytea, text, integer, text) OWNER TO shoutory_definer;
ALTER FUNCTION app.sealed_key_ids() OWNER TO shoutory_definer;
ALTER FUNCTION app.email_outbox_reseal_batch(integer, text, uuid) OWNER TO shoutory_definer;
ALTER FUNCTION app.email_outbox_reseal_write(uuid, integer, bytea, bytea, bytea, bytea, bytea, bytea, text,
  integer) OWNER TO shoutory_definer;
