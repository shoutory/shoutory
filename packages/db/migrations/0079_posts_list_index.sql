-- shoutory:no-transaction
-- The post list pages a workspace's posts by last change, newest first, with the id as the tie-break.
CREATE INDEX CONCURRENTLY posts_list_idx ON app.posts (workspace_id, updated_at DESC, id DESC);
