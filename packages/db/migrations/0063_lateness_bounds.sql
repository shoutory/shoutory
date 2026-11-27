-- A tolerance of 0 would make every post missed at the 30-second tick, so the window is 5 minutes to 24 hours. An
-- Owner or Admin sets it through the column grant.
ALTER TABLE app.workspaces
  ADD CONSTRAINT workspaces_lateness_tolerance_range
  CHECK (lateness_tolerance BETWEEN interval '5 minutes' AND interval '24 hours') NOT VALID;
GRANT UPDATE (lateness_tolerance) ON app.workspaces TO shoutory_app;
