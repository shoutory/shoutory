-- The roles come from a script that runs before the first migration, because the migration owner cannot create roles.
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS auth;

GRANT USAGE ON SCHEMA app TO shoutory_app, shoutory_worker, shoutory_auth, shoutory_readonly, shoutory_definer;

GRANT USAGE ON SCHEMA auth TO shoutory_auth, shoutory_definer;
