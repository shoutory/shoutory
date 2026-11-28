-- shoutory:no-transaction
-- The claim index that does not carry the priority is replaced by the ordered one; no other query reads it.
DROP INDEX CONCURRENTLY IF EXISTS app.operations_claim_idx;
