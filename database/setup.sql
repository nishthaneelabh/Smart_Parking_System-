-- =====================================================================
-- setup.sql — builds the whole database in the correct order.
--
--   psql -U postgres -d smart_parking -f database/setup.sql
--
-- Run it from the project root folder (the paths below are relative).
-- Safe to re-run: it drops and recreates the "parking" schema.
-- =====================================================================
\set ON_ERROR_STOP on
\echo '1/7 schema.sql'
\i database/schema.sql
\echo '2/7 functions.sql'
\i database/functions.sql
\echo '3/7 procedures.sql'
\i database/procedures.sql
\echo '4/7 triggers.sql'
\i database/triggers.sql
\echo '5/7 indexes.sql'
\i database/indexes.sql
\echo '6/7 seed.sql'
\i database/seed.sql
\echo '7/7 scheduler.sql'
\i database/scheduler.sql
\echo 'Done. Database is ready.'
