-- Runs once, on first boot of the postgres container.
-- The integration suite points at a separate database because it TRUNCATEs
-- every table between tests; pointing it at the dev database would wipe the
-- data a reviewer is looking at in the dashboard.
CREATE DATABASE reachinbox_test OWNER reachinbox;
