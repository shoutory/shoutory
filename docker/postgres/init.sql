-- Creates every database role and hands the current database to the migration owner. Run once by a superuser
-- against the application database: the official image runs it from /docker-entrypoint-initdb.d, a managed
-- PostgreSQL operator runs it with psql. It is idempotent and reads each LOGIN role's password from the
-- environment, so a missing variable stops the script instead of creating a role without a password.
--
-- Migrations create the schemas and grants; roles are never created by a migration because the migration owner
-- has no CREATEROLE.
\set ON_ERROR_STOP on

\getenv password_owner SHOUTORY_DATABASE_PASSWORD_OWNER
\getenv password_app SHOUTORY_DATABASE_PASSWORD_APP
\getenv password_worker SHOUTORY_DATABASE_PASSWORD_WORKER
\getenv password_auth SHOUTORY_DATABASE_PASSWORD_AUTH
\getenv password_readonly SHOUTORY_DATABASE_PASSWORD_READONLY

-- The statements below carry passwords: keep them (and a failing one) out of the server log for this session.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';

-- An empty value would create a role with an empty password; an unset one is a syntax error further down.
SELECT :'password_owner' = '' OR :'password_app' = '' OR :'password_worker' = ''
    OR :'password_auth' = '' OR :'password_readonly' = '' AS empty_password
\gset
\if :empty_password
  DO $$ BEGIN RAISE EXCEPTION 'every SHOUTORY_DATABASE_PASSWORD_* value must be set and not empty'; END $$;
\endif

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', name, password)
FROM (VALUES
  ('shoutory_owner', :'password_owner'),
  ('shoutory_app', :'password_app'),
  ('shoutory_worker', :'password_worker'),
  ('shoutory_auth', :'password_auth'),
  ('shoutory_readonly', :'password_readonly')
) AS roles (name, password)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = roles.name)
\gexec

-- The role that owns every SECURITY DEFINER function. It cannot log in.
SELECT 'CREATE ROLE shoutory_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'shoutory_definer')
\gexec

-- A role that already existed keeps its password but is held to the same attributes as a new one.
SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', name)
FROM (VALUES ('shoutory_owner'), ('shoutory_app'), ('shoutory_worker'), ('shoutory_auth'),
  ('shoutory_readonly'), ('shoutory_definer')) AS roles (name)
\gexec

-- The owner may switch to the definer role to hand it functions, but never inherits its privileges.
GRANT shoutory_definer TO shoutory_owner WITH INHERIT FALSE, SET TRUE;

-- The owner creates the schemas, so it owns the database.
SELECT format('ALTER DATABASE %I OWNER TO shoutory_owner', current_database())
\gexec
