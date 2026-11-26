-- A person's own profile picture. The image lives in storage under the user's key; this row says whether there is one
-- and when it last changed, which the web app also uses to refetch it.

ALTER TABLE app.user_profiles ADD COLUMN avatar_at timestamptz;

CALL app.grant_purposes('user_profiles', 'SELECT', ARRAY['user_avatar_set']);
CALL app.grant_purposes('user_profiles', 'INSERT', ARRAY['user_avatar_set']);
CALL app.grant_purposes('user_profiles', 'UPDATE', ARRAY['user_avatar_set']);

-- The user is the caller of the transaction, never an argument, so nobody can set another person's picture.
CREATE FUNCTION app.user_avatar_set(at timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
  caller constant uuid := app.principal_id();
BEGIN
  IF caller IS NULL OR app.principal_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'user_avatar_set: refused' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.job_purpose', 'user_avatar_set', true);
  INSERT INTO app.user_profiles (user_id, avatar_at) VALUES (caller, user_avatar_set.at)
    ON CONFLICT ON CONSTRAINT user_profiles_pkey DO UPDATE SET avatar_at = EXCLUDED.avatar_at;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.user_avatar_set(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.user_avatar_set(timestamptz) TO shoutory_app;
ALTER FUNCTION app.user_avatar_set(timestamptz) OWNER TO shoutory_definer;
