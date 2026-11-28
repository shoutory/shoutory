-- A notification is kept 90 days from its creation, read or not; the daily purge removes the rest.
CREATE POLICY retention_seed_insert ON app.retention_classes FOR INSERT TO shoutory_owner WITH CHECK (true);
INSERT INTO app.retention_classes (class, table_name, kind, event_column, retain, partition_unit) VALUES
  ('app.notifications', 'app.notifications', 'window', 'created_at', interval '90 days', NULL);
DROP POLICY retention_seed_insert ON app.retention_classes;
GRANT DELETE ON app.notifications TO shoutory_definer;
CALL app.grant_purposes('notifications', 'SELECT', ARRAY['purge_expired']);
CALL app.grant_purposes('notifications', 'DELETE', ARRAY['purge_expired']);
