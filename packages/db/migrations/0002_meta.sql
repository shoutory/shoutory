-- The record of applied migrations. The runner creates this table itself before the first file so it can read
-- it under the lock; this file keeps the shipped history complete and lets the runtime roles read it, which the
-- start-up check does.
CREATE TABLE IF NOT EXISTS app.schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON app.schema_migrations TO shoutory_app, shoutory_worker;
