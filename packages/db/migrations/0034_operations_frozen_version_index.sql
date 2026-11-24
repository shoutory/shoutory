-- shoutory:no-transaction
-- The autosave purge and the foreign-key check of a version delete look operations up by the version they froze.
CREATE INDEX CONCURRENTLY operations_frozen_version_idx ON app.operations (workspace_id, frozen_version_id)
  WHERE frozen_version_id IS NOT NULL;
