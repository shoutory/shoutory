-- shoutory:no-transaction
-- Admission looks for threads in progress whose next part is due, ordered by variant.
CREATE INDEX CONCURRENTLY post_variants_in_progress_idx ON app.post_variants (id)
  WHERE schedule_state = 'in_progress';
