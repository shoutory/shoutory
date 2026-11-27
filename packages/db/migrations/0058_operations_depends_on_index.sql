-- shoutory:no-transaction
-- Admission checks whether a delete already has a delete that depends on it.
CREATE INDEX CONCURRENTLY operations_depends_on_idx ON app.operations (workspace_id, depends_on_operation_id)
  WHERE depends_on_operation_id IS NOT NULL;
