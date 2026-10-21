-- =====================================================================
-- FILE 7 of 7 : scheduler.sql — automatic expiry every minute
--
-- OPTION 1 (preferred): pg_cron
--   pg_cron must be installed AND listed in postgresql.conf:
--       shared_preload_libraries = 'pg_cron'
--       cron.database_name = 'smart_parking'
--   then restart PostgreSQL and run this file.
--   If pg_cron is not available this file only prints a NOTICE — nothing fails.
--
-- OPTION 2 (works everywhere): the Python scheduler
--       python scripts/scheduler.py            (runs every 60 s)
--       python scripts/scheduler.py --once     (runs one time)
--
-- OPTION 3 (manual, e.g. during the demo):
--       CALL parking.sp_run_scheduled_jobs();
--
-- All three call the same stored procedure, so the logic is in one place.
-- =====================================================================
SET search_path = parking, public;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
        BEGIN
            CREATE EXTENSION IF NOT EXISTS pg_cron;
            PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'smart_parking_expiry';
            PERFORM cron.schedule('smart_parking_expiry', '* * * * *',
                                  'CALL parking.sp_run_scheduled_jobs()');
            RAISE NOTICE 'pg_cron job "smart_parking_expiry" scheduled every minute.';
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'pg_cron is installed but could not be used here (%). Use scripts/scheduler.py instead.', SQLERRM;
        END;
    ELSE
        RAISE NOTICE 'pg_cron is not installed. Run "python scripts/scheduler.py" for automatic expiry.';
    END IF;
END $$;
