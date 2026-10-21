-- =====================================================================
-- benchmark.sql — OPTIONAL index benchmark with a larger data set
--
--   psql -d smart_parking -f database/benchmark.sql
--
-- The seed data (19 reservations) is far too small for indexes to matter:
-- PostgreSQL would simply read the whole table. This script therefore
--   1. adds ~200,000 historical + 2,000 upcoming reservations,
--   2. runs each query WITH its index (EXPLAIN ANALYZE),
--   3. drops that index and runs the same query again,
-- and everything happens inside ONE transaction that is ROLLED BACK at the
-- end, so your real data is left exactly as it was.
--
-- Timings depend on your machine — run it yourself and quote your numbers.
-- =====================================================================
SET search_path = parking, public;
\timing off
BEGIN;

-- Speed up the bulk load: skip row triggers (audit etc.) for this transaction only
ALTER TABLE reservations DISABLE TRIGGER USER;

-- 40 benchmark vehicles (one per slot) so upcoming bookings never overlap per vehicle
INSERT INTO vehicles (user_id, registration_no, model_name, vehicle_type)
SELECT 2, 'BM' || lpad(g::text, 2, '0') || 'ZZ' || lpad(g::text, 4, '0'), 'Benchmark car', 'SUV'
FROM generate_series(1, 40) g;

-- ~200,000 COMPLETED reservations spread over the last 3 years
INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, status,
                          parking_fee, check_in_time, check_out_time, created_at)
SELECT u, v, s, st, st + interval '2 hours', 'COMPLETED', 80, st, st + interval '2 hours', st - interval '1 day'
FROM (
    -- user 7 (Kavya) is a light user: only 1 row in 1000 is hers (~200 bookings)
    SELECT u, (SELECT vehicle_id FROM vehicles WHERE user_id = u ORDER BY vehicle_id LIMIT 1) AS v, s, st
    FROM (
    SELECT CASE WHEN g % 1000 = 0 THEN 7 ELSE (ARRAY[2,3,4,5,6,8,9,10,11,12])[1 + g % 10] END AS u,
           1 + (g % 40) AS s,
           now() - interval '3 years' + (g * interval '7 minutes') AS st
    FROM generate_series(1, 200000) g
    ) y
) x WHERE v IS NOT NULL;

-- 2,000 upcoming CONFIRMED reservations (50 per slot, back to back)
INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, status, parking_fee)
SELECT 2, v.vehicle_id, s.slot_id,
       date_trunc('hour', now()) + interval '3 days' + k * interval '2 hours',
       date_trunc('hour', now()) + interval '3 days' + (k + 1) * interval '2 hours',
       'CONFIRMED', 80
FROM generate_series(0, 49) k
JOIN parking_slots s ON TRUE
JOIN vehicles v ON v.registration_no = 'BM' || lpad(s.slot_id::text, 2, '0') || 'ZZ' || lpad(s.slot_id::text, 4, '0');

ANALYZE reservations;
SELECT count(*) AS total_reservations FROM reservations;

-- ---------------------------------------------------------------------
\echo '=== Q1. User booking history (My Bookings page) — WITH idx_res_user_start'
EXPLAIN (ANALYZE, COSTS OFF, SUMMARY ON)
SELECT reservation_id, start_time, status FROM reservations
WHERE user_id = 7 ORDER BY start_time DESC LIMIT 20;

\echo '=== Q2. Scheduler: HELD rows whose hold expired — WITH partial idx_res_held_expiry'
EXPLAIN (ANALYZE, COSTS OFF, SUMMARY ON)
SELECT reservation_id FROM reservations WHERE status = 'HELD' AND hold_expires_at <= now();

\echo '=== Q3. Is slot 8 free 4 days from now 10:00-12:00? — WITH GiST index of ex_res_no_slot_overlap'
EXPLAIN (ANALYZE, COSTS OFF, SUMMARY ON)
SELECT EXISTS (SELECT 1 FROM reservations
               WHERE slot_id = 8 AND status IN ('HELD','CONFIRMED','CHECKED_IN')
                 AND booking_period && tstzrange(date_trunc('hour', now()) + interval '4 days 10 hours',
                                                 date_trunc('hour', now()) + interval '4 days 12 hours', '[)'));

-- ---------------------------------------------------------------------
-- Now remove the indexes (inside the same transaction) and repeat.
-- The two EXCLUDE constraints are dropped together because their GiST
-- indexes can stand in for each other (both index booking_period).
DROP INDEX idx_res_user_start;
DROP INDEX idx_res_held_expiry;
ALTER TABLE reservations DROP CONSTRAINT ex_res_no_slot_overlap;
ALTER TABLE reservations DROP CONSTRAINT ex_res_no_vehicle_overlap;
ANALYZE reservations;

\echo '=== Q1 WITHOUT index'
EXPLAIN (ANALYZE, COSTS OFF, SUMMARY ON)
SELECT reservation_id, start_time, status FROM reservations
WHERE user_id = 7 ORDER BY start_time DESC LIMIT 20;

\echo '=== Q2 WITHOUT index'
EXPLAIN (ANALYZE, COSTS OFF, SUMMARY ON)
SELECT reservation_id FROM reservations WHERE status = 'HELD' AND hold_expires_at <= now();

\echo '=== Q3 WITHOUT index'
EXPLAIN (ANALYZE, COSTS OFF, SUMMARY ON)
SELECT EXISTS (SELECT 1 FROM reservations
               WHERE slot_id = 8 AND status IN ('HELD','CONFIRMED','CHECKED_IN')
                 AND booking_period && tstzrange(date_trunc('hour', now()) + interval '4 days 10 hours',
                                                 date_trunc('hour', now()) + interval '4 days 12 hours', '[)'));

ROLLBACK;   -- everything above is undone; the real database is unchanged
\echo 'Benchmark finished. All benchmark data was rolled back.'
