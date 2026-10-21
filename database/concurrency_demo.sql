-- =====================================================================
-- concurrency_demo.sql — DOUBLE-BOOKING PREVENTION, BY HAND, IN TWO TERMINALS
--
-- Open TWO terminals and connect both to the database:
--     psql -U postgres -d smart_parking
-- Each terminal is a separate connection = a separate PostgreSQL process.
-- Run the steps IN ORDER, switching terminals as shown.
--
-- Slot 8 = Phoenix Marketcity E03 (DC, CCS2).
-- User 13 / vehicle 13 = Demo User A,  user 14 / vehicle 14 = Demo User B.
-- The time used is TOMORROW 12:00–14:00 India time.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PART 1 — using the safe booking function
-- ---------------------------------------------------------------------

-- [TERMINAL 1 and TERMINAL 2] — run once in each, to define the time window
\set t_start '(date_trunc(''day'', now() AT TIME ZONE ''Asia/Kolkata'') + interval ''1 day 12 hours'') AT TIME ZONE ''Asia/Kolkata'''
\set t_end   '(date_trunc(''day'', now() AT TIME ZONE ''Asia/Kolkata'') + interval ''1 day 14 hours'') AT TIME ZONE ''Asia/Kolkata'''

-- [TERMINAL 1]  User A starts a transaction and books. It gets the row lock.
BEGIN;
SELECT fn_create_reservation(13, 13, 8, :t_start, :t_end) AS reservation_a;
--   -> returns a reservation id. DO NOT COMMIT YET.

-- [TERMINAL 2]  User B tries to book the SAME slot and time.
BEGIN;
SELECT fn_create_reservation(14, 14, 8, :t_start, :t_end) AS reservation_b;
--   -> this command HANGS. It is waiting for User A's lock (SELECT ... FOR UPDATE).

-- [TERMINAL 3, optional]  See the waiting transaction:
--   SELECT pid, state, wait_event_type, wait_event, left(query, 60)
--   FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle';

-- [TERMINAL 1]  User A commits.
COMMIT;

-- [TERMINAL 2]  Immediately prints:
--   ERROR:  Slot Unavailable: it is already reserved for an overlapping time
--   HINT:   SLOT_UNAVAILABLE
ROLLBACK;

-- [EITHER]  Verify: exactly ONE active reservation for that slot and time
SELECT reservation_id, user_id, status, start_time, end_time
FROM reservations
WHERE slot_id = 8 AND status IN ('HELD', 'CONFIRMED', 'CHECKED_IN')
  AND booking_period && tstzrange(:t_start, :t_end, '[)');

-- Clean up so you can repeat the demo
SELECT fn_cancel_reservation(reservation_id, user_id, TRUE, 'demo clean-up')
FROM reservations
WHERE slot_id = 8 AND status = 'HELD' AND booking_period && tstzrange(:t_start, :t_end, '[)');


-- ---------------------------------------------------------------------
-- PART 2 — NOWAIT: the second user is told "busy" instantly instead of waiting
-- ---------------------------------------------------------------------
-- [TERMINAL 1]
BEGIN;
SELECT fn_create_reservation(13, 13, 8, :t_start, :t_end, 'DIRECT', TRUE);
-- [TERMINAL 2]
BEGIN;
SELECT fn_create_reservation(14, 14, 8, :t_start, :t_end, 'DIRECT', TRUE);
--   -> fails at once: "Another user is booking this slot right now" (HINT SLOT_BUSY)
ROLLBACK;
-- [TERMINAL 1]
ROLLBACK;     -- (or COMMIT)


-- ---------------------------------------------------------------------
-- PART 3 — the same idea in plain SQL (what the function does inside)
-- ---------------------------------------------------------------------
-- [TERMINAL 1]
BEGIN;
SELECT slot_id, slot_code FROM parking_slots WHERE slot_id = 8 FOR UPDATE;      -- 1. lock the slot row
SELECT count(*) AS clashes FROM reservations                                    -- 2. check latest bookings
 WHERE slot_id = 8 AND status IN ('HELD','CONFIRMED','CHECKED_IN')
   AND booking_period && tstzrange(:t_start, :t_end, '[)');
INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, hold_expires_at, parking_fee, charging_fee)
VALUES (13, 13, 8, :t_start, :t_end, now() + interval '10 minutes', 100, 375);    -- 3. reserve

-- [TERMINAL 2]
BEGIN;
SELECT slot_id, slot_code FROM parking_slots WHERE slot_id = 8 FOR UPDATE;      -- waits here ...

-- [TERMINAL 1]
COMMIT;

-- [TERMINAL 2]  the lock is granted; now the check sees User A's row:
SELECT count(*) AS clashes FROM reservations
 WHERE slot_id = 8 AND status IN ('HELD','CONFIRMED','CHECKED_IN')
   AND booking_period && tstzrange(:t_start, :t_end, '[)');                      -- returns 1 -> do not insert
ROLLBACK;


-- ---------------------------------------------------------------------
-- PART 4 — even WITHOUT any lock, the EXCLUDE constraint refuses overlap
-- ---------------------------------------------------------------------
-- [ANY TERMINAL]  (User A's row from part 3 is still there)
INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, hold_expires_at)
VALUES (14, 14, 8, :t_start + interval '1 hour', :t_end + interval '1 hour', now() + interval '10 minutes');
--   ERROR:  conflicting key value violates exclusion constraint "ex_res_no_slot_overlap"

-- Clean up
UPDATE reservations SET status = 'CANCELLED', cancel_reason = 'demo clean-up'
WHERE slot_id = 8 AND status = 'HELD' AND booking_period && tstzrange(:t_start, :t_end, '[)');
