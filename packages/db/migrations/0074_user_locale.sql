-- The language of a person's mail, written by the auth role when an account is made and when it signs in. Nothing else
-- writes the column.
CALL app.grant_purposes('user_profiles', 'SELECT', ARRAY['user_locale_set']);
CALL app.grant_purposes('user_profiles', 'INSERT', ARRAY['user_locale_set']);
CALL app.grant_purposes('user_profiles', 'UPDATE', ARRAY['user_locale_set']);

SET ROLE shoutory_definer;

CREATE FUNCTION app.user_locale_set(p_user_id uuid, p_locale text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  prior text := current_setting('app.job_purpose', true);
BEGIN
  IF p_locale IS NULL OR p_locale NOT IN ('en', 'ar') THEN
    RAISE EXCEPTION 'user_locale_set: the language is en or ar' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.job_purpose', 'user_locale_set', true);
  INSERT INTO app.user_profiles (user_id, locale) VALUES (p_user_id, p_locale)
    ON CONFLICT ON CONSTRAINT user_profiles_pkey DO UPDATE SET locale = EXCLUDED.locale;
  PERFORM set_config('app.job_purpose', coalesce(prior, ''), true);
END
$$;

REVOKE ALL ON FUNCTION app.user_locale_set(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.user_locale_set(uuid, text) TO shoutory_auth;

RESET ROLE;
