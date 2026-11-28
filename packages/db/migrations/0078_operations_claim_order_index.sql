-- shoutory:no-transaction
-- The claim takes pending operations of one queue in the order priority first, then the oldest, then the id.
CREATE INDEX CONCURRENTLY operations_claim_order_idx ON app.operations (queue, priority DESC, next_attempt_at, id)
  WHERE state = 'pending';
