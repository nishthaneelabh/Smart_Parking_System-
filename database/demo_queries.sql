-- =====================================================================
-- demo_queries.sql — commands an examiner can run to verify the system
--
--   psql -U postgres -d smart_parking
--   then copy-paste a section at a time (or: \i database/demo_queries.sql
--   after reloading the seed — some sections change data).
--
-- Reload clean sample data at any time with:   \i database/seed.sql
-- =====================================================================
SET search_path = parking, public;

-- ---------------------------------------------------------------------
-- 1. Look at the structure
-- ---------------------------------------------------------------------
-- \dt                       list tables
-- \d reservations           columns, constraints, indexes, triggers
-- \df fn_*                  list functions
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'reservations'::regclass;

-- ---------------------------------------------------------------------
-- 2. Sample data overview
-- ---------------------------------------------------------------------
SELECT status, count(*) FROM reservations GROUP BY status ORDER BY 2 DESC;
SELECT * FROM v_slot_overview WHERE location_id = 1;
SELECT reservation_id, full_name, location_name, slot_code, status, total_amount FROM v_reservation_details ORDER BY 1;

-- ---------------------------------------------------------------------
-- 3. Availability: physical NOW vs FUTURE reservations
-- ---------------------------------------------------------------------
-- Physical right now (maintained by trigger B):
SELECT slot_id, location_name, slot_code, occupancy_status FROM v_slot_overview WHERE occupancy_status = 'OCCUPIED';
-- Future availability for tomorrow 18:00-20:00 at Chennai Central (location 3), DC chargers:
SELECT slot_code, charger_type, est_total
FROM fn_search_available_slots(
       (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day 18 hours') AT TIME ZONE 'Asia/Kolkata',
       (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day 20 hours') AT TIME ZONE 'Asia/Kolkata',
       3, NULL, 'EV', 'DC');                 -- 0 rows: both DC chargers are booked -> waiting list scenario
-- ... but both slots are physically FREE right now:
SELECT slot_code, occupancy_status FROM parking_slots WHERE location_id = 3 AND slot_type = 'EV';

-- ---------------------------------------------------------------------
-- 4. Dynamic pricing (fn_calculate_price)
-- ---------------------------------------------------------------------
-- Wednesday 13:00-15:00 (off-peak) vs 17:00-19:00 (evening peak ×1.5), regular slot, location 1 (₹40/h)
SELECT * FROM fn_calculate_price(1, 'REGULAR', NULL, '2030-01-09 13:00+05:30', '2030-01-09 15:00+05:30');  -- 80
SELECT * FROM fn_calculate_price(1, 'REGULAR', NULL, '2030-01-09 17:00+05:30', '2030-01-09 19:00+05:30');  -- 120
-- AC vs DC fast charging, same time
SELECT * FROM fn_calculate_price(1, 'EV', 'AC', '2030-01-09 13:00+05:30', '2030-01-09 15:00+05:30');       -- 80 + 120
SELECT * FROM fn_calculate_price(1, 'EV', 'DC', '2030-01-09 13:00+05:30', '2030-01-09 15:00+05:30');       -- 80 + 300
-- Rates come from tables:
SELECT * FROM pricing_rules ORDER BY location_id NULLS FIRST, applies_to;
SELECT * FROM peak_hours;

-- ---------------------------------------------------------------------
-- 5. Trigger A — overstay fine (already applied to seed rows 2, 3, 4)
-- ---------------------------------------------------------------------
SELECT reservation_id, end_time, check_out_time,
       round(extract(epoch FROM check_out_time - end_time) / 60) AS minutes_late, overstay_fine
FROM reservations WHERE reservation_id IN (2, 3, 4, 6);
--   #3: 10 min late (inside 15-min grace) -> ₹0
--   #2: 70 min late -> 2 started hours × ₹40 × 2 = ₹160
--   #4: 150 min late -> 3 × ₹40 × 2 = ₹240 (still unpaid -> balance due)
SELECT * FROM fn_final_bill(4);

-- Live: Rahul (reservation 13) is checked in on slot A01. Check him out 70 min after his end time:
BEGIN;
SELECT * FROM fn_check_out(13, 1, TRUE, (SELECT end_time + interval '70 minutes' FROM reservations WHERE reservation_id = 13));
SELECT slot_code, occupancy_status FROM parking_slots WHERE slot_id = 1;   -- trigger B: FREE again
ROLLBACK;                                                                    -- undo, keep data for later

-- ---------------------------------------------------------------------
-- 6. Trigger C — faulty charger
-- ---------------------------------------------------------------------
BEGIN;
-- Book & pay Demo User A on Phoenix Marketcity E03 (slot 8) for tomorrow 12-14
SELECT fn_create_reservation(13, 13, 8,
       (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day 12 hours') AT TIME ZONE 'Asia/Kolkata',
       (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day 14 hours') AT TIME ZONE 'Asia/Kolkata') AS rid \gset
SELECT fn_make_payment(:rid, 13, 'UPI');
CALL sp_mark_charger_faulty(3, 'Connector damaged', 1);                -- charger 3 sits on slot 8
SELECT reservation_id, status, cancel_reason FROM reservations WHERE reservation_id = :rid;   -- CANCELLED
SELECT status FROM payments WHERE reservation_id = :rid;                                     -- REFUNDED
SELECT entry_id, user_id, priority, status FROM waiting_list WHERE user_id = 13;              -- priority 4
SELECT fn_create_reservation(14, 14, 8, now() + interval '2 days', now() + interval '2 days 2 hours');  -- ERROR CHARGER_FAULTY
ROLLBACK;

-- ---------------------------------------------------------------------
-- 7. Waiting list progression
-- ---------------------------------------------------------------------
SELECT entry_id, full_name, priority, priority_label, requested_at, queue_position
FROM v_waiting_queue WHERE status = 'WAITING' ORDER BY queue_position;     -- Arjun(3), Meera(1), Divya(1)
BEGIN;
SELECT fn_cancel_reservation(14, 2);                                         -- Rohan frees a DC charger
SELECT entry_id, full_name, status, offered_reservation_id, offer_expires_at FROM v_waiting_queue ORDER BY entry_id;
--   Arjun -> OFFERED (10-minute hold), others still WAITING
-- simulate Arjun not paying in time:
UPDATE reservations SET hold_expires_at = now() - interval '1 second'
 WHERE reservation_id = (SELECT offered_reservation_id FROM waiting_list WHERE user_id = 6 AND status = 'OFFERED');
SELECT * FROM fn_run_expiry_jobs();
SELECT entry_id, full_name, status FROM v_waiting_queue ORDER BY entry_id;   -- Arjun EXPIRED, Meera OFFERED
ROLLBACK;

-- ---------------------------------------------------------------------
-- 8. Scheduled jobs (safe to run repeatedly)
-- ---------------------------------------------------------------------
CALL sp_run_scheduled_jobs();
CALL sp_run_scheduled_jobs();       -- second run: nothing left to do

-- ---------------------------------------------------------------------
-- 9. Integrity checks — each of these must FAIL
-- ---------------------------------------------------------------------
-- INSERT INTO vehicles (user_id, registration_no, model_name) VALUES (999, 'TN01AA0001', 'x');   -- FK violation
-- INSERT INTO users (full_name, email, phone, password_hash) VALUES ('x', 'admin@smartpark.in', '9000000099', 'x'); -- UNIQUE
-- INSERT INTO chargers (slot_id, charger_type, connector_type, power_kw) VALUES (6, 'AC', 'CCS2', 150);  -- CHECK
-- DELETE FROM locations WHERE location_id = 1;                                                -- RESTRICT

-- The invariant behind everything — must always return 0 rows:
SELECT a.reservation_id, b.reservation_id
FROM reservations a JOIN reservations b
  ON a.slot_id = b.slot_id AND a.reservation_id < b.reservation_id
 AND a.booking_period && b.booking_period
WHERE a.status IN ('HELD','CONFIRMED','CHECKED_IN') AND b.status IN ('HELD','CONFIRMED','CHECKED_IN');

-- ---------------------------------------------------------------------
-- 10. Index usage
-- ---------------------------------------------------------------------
EXPLAIN ANALYZE SELECT * FROM reservations WHERE user_id = 2 ORDER BY start_time DESC LIMIT 20;
-- With only ~20 rows PostgreSQL may prefer a sequential scan (that is correct!).
-- See database/benchmark.sql for a 200,000-row comparison.
SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE schemaname = 'parking' ORDER BY idx_scan DESC;
