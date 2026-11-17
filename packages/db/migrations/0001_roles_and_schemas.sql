-- The two schemas and who may use them. The roles themselves come from the role script that runs before the first
-- migration (the migration owner cannot create roles). Nobody but the owner may create objects in either schema.
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS auth;

GRANT USAGE ON SCHEMA app TO shoutory_app, shoutory_worker, shoutory_auth, shoutory_readonly, shoutory_definer;

-- The auth schema belongs to the identity library's own role; the definer role reads a few of its columns later.
GRANT USAGE ON SCHEMA auth TO shoutory_auth, shoutory_definer;
