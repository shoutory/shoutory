-- shoutory:no-transaction
-- Admission looks for published deletes of a thread part that have no delete after them yet.
CREATE INDEX CONCURRENTLY operations_published_delete_idx ON app.operations (id)
  WHERE kind = 'delete' AND state = 'published' AND part_index > 0;
