-- =====================================================================
-- FILE 3 of 7 : procedures.sql — stored PROCEDURES (invoked with CALL)
--
-- Function vs procedure in PostgreSQL:
--   FUNCTION  : called inside a query (SELECT fn(...)), returns a value,
--               always runs inside the caller's transaction.
--   PROCEDURE : called with CALL, returns nothing (or INOUT params),
--               and may COMMIT / ROLLBACK inside itself (when not called
--               from inside an outer transaction block).
-- =====================================================================
SET search_path = parking, public;

-- ---------------------------------------------------------------------
-- sp_run_scheduled_jobs()
--   The entry point used by pg_cron (every minute) and by
--   scripts/scheduler.py. Wraps fn_run_expiry_jobs() and prints a summary.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_run_scheduled_jobs()
LANGUAGE plpgsql AS $$
DECLARE
    r RECORD;
BEGIN
    SELECT * INTO r FROM fn_run_expiry_jobs();
    RAISE NOTICE 'Scheduled jobs: % hold(s) expired, % no-show(s), % wait(s) expired, % offer(s) made',
                 r.expired_holds, r.no_shows, r.expired_waits, r.offers_made;
END $$;

-- ---------------------------------------------------------------------
-- sp_mark_charger_faulty(charger, issue, admin)
--   Opens a maintenance ticket with the admin's description, then flips
--   the status. Trigger C cancels/refunds/requeues affected bookings.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_mark_charger_faulty(
    p_charger_id  INTEGER,
    p_issue       TEXT,
    p_admin_id    INTEGER DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM chargers WHERE charger_id = p_charger_id FOR UPDATE;
    IF NOT FOUND THEN
        PERFORM fn_raise('CHARGER_NOT_FOUND', 'Charger not found');
    END IF;
    IF v_status = 'FAULTY' THEN
        PERFORM fn_raise('ALREADY_FAULTY', 'Charger is already marked faulty');
    END IF;

    INSERT INTO charger_maintenance (charger_id, issue_description, reported_by)
    VALUES (p_charger_id, coalesce(nullif(trim(p_issue), ''), 'Charger marked FAULTY'), p_admin_id);

    UPDATE chargers SET status = 'FAULTY' WHERE charger_id = p_charger_id;
END $$;

-- ---------------------------------------------------------------------
-- sp_mark_charger_repaired(charger, note)
--   Closes the open ticket with the note, flips the status back to
--   OPERATIONAL (trigger C closes any other open ticket) and runs the
--   waiting list so priority-4 drivers can be rebooked straight away.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_mark_charger_repaired(
    p_charger_id  INTEGER,
    p_note        TEXT DEFAULT 'Charger repaired')
LANGUAGE plpgsql AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM chargers WHERE charger_id = p_charger_id FOR UPDATE;
    IF NOT FOUND THEN
        PERFORM fn_raise('CHARGER_NOT_FOUND', 'Charger not found');
    END IF;
    IF v_status <> 'FAULTY' THEN
        PERFORM fn_raise('NOT_FAULTY', 'Charger is not faulty');
    END IF;

    UPDATE charger_maintenance
       SET resolved_at = now(), resolution_note = coalesce(nullif(trim(p_note), ''), 'Charger repaired')
     WHERE charger_id = p_charger_id AND resolved_at IS NULL;

    UPDATE chargers SET status = 'OPERATIONAL' WHERE charger_id = p_charger_id;

    PERFORM fn_process_waiting_list();
END $$;
