-- =====================================================================
-- FILE 6 of 7 : seed.sql — realistic Indian sample data (repeatable)
--
-- Re-running this file wipes every table and inserts the same data again.
-- All reservation times are RELATIVE to the moment you run it, so the
-- "upcoming", "active now" and "history" bookings always make sense.
--
-- Logins (all sample users):   password  Password@123
-- Admin:  admin@smartpark.in   password  Admin@123
-- =====================================================================
SET search_path = parking, public;

TRUNCATE audit_logs, payments, waiting_list, reservations, charger_maintenance,
         chargers, parking_slots, pricing_rules, peak_hours, vehicles, locations,
         users, booking_policy
RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------
-- Policy (one row): 10-min hold, 15-min grace, 2× overstay rate ...
-- ---------------------------------------------------------------------
INSERT INTO booking_policy DEFAULT VALUES;

-- ---------------------------------------------------------------------
-- Users  (IDs 1..14 because of RESTART IDENTITY)
-- ---------------------------------------------------------------------
INSERT INTO users (full_name, email, phone, password_hash, role, membership_tier, has_accessibility_permit) VALUES
 ('Ananya Iyer',          'admin@smartpark.in',         '9840000001', 'scrypt:32768:8:1$JSaH1GNDAgiwyC5x$86987c68f461b9015daf73424e5dc58a35b8e2981812bc1d3db993141241edd7cd50347dfbe11a0d9502cb8be407e00b2b1af31005c774c6e60525a417556c3b', 'ADMIN', 'STANDARD', FALSE),
 ('Rohan Sharma',         'rohan.sharma@example.in',    '9840000002', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'PREMIUM',  FALSE),
 ('Meera Pillai',         'meera.pillai@example.in',    '9840000003', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'STANDARD', FALSE),
 ('Rahul Verma',          'rahul.verma@example.in',     '9840000004', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'STANDARD', FALSE),
 ('Priya Raghavan',       'priya.raghavan@example.in',  '9840000005', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'PREMIUM',  FALSE),
 ('Arjun Mehta',          'arjun.mehta@example.in',     '9840000006', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'STANDARD', TRUE),
 ('Kavya Nair',           'kavya.nair@example.in',      '9840000007', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'STANDARD', FALSE),
 ('Vikram Singh',         'vikram.singh@example.in',    '9840000008', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'PREMIUM',  FALSE),
 ('Sneha Patil',          'sneha.patil@example.in',     '9840000009', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'STANDARD', FALSE),
 ('Mohammed Irfan',       'mohammed.irfan@example.in',  '9840000010', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'STANDARD', FALSE),
 ('Divya Krishnan',       'divya.krishnan@example.in',  '9840000011', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'STANDARD', FALSE),
 ('Karthik Subramanian',  'karthik.s@example.in',       '9840000012', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'STANDARD', FALSE),
 ('Demo User A',          'demo.a@example.in',          '9840000013', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'STANDARD', FALSE),
 ('Demo User B',          'demo.b@example.in',          '9840000014', 'scrypt:32768:8:1$0UYQd7aaDXOeyZmA$3b3d793db6c4ea5a0e51b1d39ed2d28d5704d4e00978af78e6be1a68127364c914113c188c09d256e1f76458735e5becb1ddf5b7959268244031a303efb25b4b', 'USER', 'STANDARD', FALSE);

-- ---------------------------------------------------------------------
-- Vehicles
-- ---------------------------------------------------------------------
INSERT INTO vehicles (user_id, registration_no, vehicle_type, model_name, is_ev, connector_type) VALUES
 ( 2, 'TN09AB1234', 'SUV',  'Tata Nexon EV',              TRUE,  'CCS2'),
 ( 2, 'TN10CD5678', 'CAR',  'Honda City',                 FALSE, NULL),
 ( 3, 'TN07EF2345', 'SUV',  'MG ZS EV',                   TRUE,  'CCS2'),
 ( 4, 'KA03MX4521', 'CAR',  'Maruti Suzuki Swift',        FALSE, NULL),
 ( 5, 'KA05PR7788', 'SUV',  'Hyundai Kona Electric',      TRUE,  'CCS2'),
 ( 6, 'MH12DE1433', 'SUV',  'Mahindra XUV400',            TRUE,  'CCS2'),
 ( 7, 'TN22KN3344', 'CAR',  'MG Comet EV',                TRUE,  'TYPE2'),
 ( 8, 'MH01VS9090', 'SUV',  'Toyota Fortuner',            FALSE, NULL),
 ( 9, 'MH02SP6655', 'CAR',  'Nissan Leaf',                TRUE,  'CHADEMO'),
 (10, 'TN01MI1122', 'CAR',  'Tata Tigor EV (Bharat AC)',  TRUE,  'BHARAT_AC001'),
 (11, 'TN09DK4455', 'CAR',  'Tata Punch EV',              TRUE,  'CCS2'),
 (12, 'TN11KS7890', 'BIKE', 'Royal Enfield Classic 350',  FALSE, NULL),
 (13, 'TN99DA0001', 'SUV',  'Tata Nexon EV',              TRUE,  'CCS2'),
 (14, 'TN99DB0002', 'SUV',  'MG ZS EV',                   TRUE,  'CCS2'),
 ( 3, 'TN07GH9012', 'CAR',  'Hyundai i20',                FALSE, NULL);

-- ---------------------------------------------------------------------
-- Locations (IDs 1..6)
-- ---------------------------------------------------------------------
INSERT INTO locations (name, address, city, pincode, latitude, longitude) VALUES
 ('Phoenix Marketcity',            '142 Velachery Main Road, Velachery',        'Chennai',   '600042', 12.991000, 80.216900),
 ('Express Avenue Mall',           '49-50 Whites Road, Royapettah',             'Chennai',   '600014', 13.058600, 80.264200),
 ('Chennai Central Metro Parking', 'Poonamallee High Road, Park Town',          'Chennai',   '600003', 13.081900, 80.273800),
 ('VIT Chennai Campus',            'Vandalur-Kelambakkam Road, Kelambakkam',    'Chennai',   '600127', 12.840600, 80.153400),
 ('Orion Mall',                    'Dr Rajkumar Road, Rajajinagar',             'Bengaluru', '560055', 13.011200, 77.555000),
 ('Phoenix Palladium',             '462 Senapati Bapat Marg, Lower Parel',      'Mumbai',    '400013', 18.994700, 72.825300);

-- ---------------------------------------------------------------------
-- Parking slots (40 total, 16 EV)
-- ---------------------------------------------------------------------
INSERT INTO parking_slots (location_id, slot_code, floor_level, slot_type, size_class) VALUES
 -- 1 Phoenix Marketcity
 (1,'A01',-1,'REGULAR','CAR'),(1,'A02',-1,'REGULAR','CAR'),(1,'A03',-1,'REGULAR','CAR'),
 (1,'A04',-1,'REGULAR','BIKE'),(1,'A05',-1,'REGULAR','SUV'),
 (1,'E01',-1,'EV','SUV'),(1,'E02',-1,'EV','SUV'),(1,'E03',-1,'EV','SUV'),
 -- 2 Express Avenue
 (2,'B01',-2,'REGULAR','CAR'),(2,'B02',-2,'REGULAR','CAR'),(2,'B03',-2,'REGULAR','SUV'),(2,'B04',-2,'REGULAR','BIKE'),
 (2,'E01',-2,'EV','SUV'),(2,'E02',-2,'EV','CAR'),(2,'E03',-2,'EV','CAR'),
 -- 3 Chennai Central Metro
 (3,'C01',0,'REGULAR','CAR'),(3,'C02',0,'REGULAR','CAR'),(3,'C03',0,'REGULAR','SUV'),
 (3,'E01',0,'EV','SUV'),(3,'E02',0,'EV','SUV'),
 -- 4 VIT Chennai
 (4,'V01',0,'REGULAR','CAR'),(4,'V02',0,'REGULAR','CAR'),(4,'V03',0,'REGULAR','SUV'),
 (4,'V04',0,'REGULAR','CAR'),(4,'V05',0,'REGULAR','BIKE'),
 (4,'E01',0,'EV','CAR'),(4,'E02',0,'EV','CAR'),(4,'E03',0,'EV','SUV'),
 -- 5 Orion Mall
 (5,'O01',-1,'REGULAR','CAR'),(5,'O02',-1,'REGULAR','CAR'),(5,'O03',-1,'REGULAR','SUV'),(5,'O04',-1,'REGULAR','CAR'),
 (5,'E01',-1,'EV','SUV'),(5,'E02',-1,'EV','SUV'),(5,'E03',-1,'EV','SUV'),
 -- 6 Phoenix Palladium
 (6,'P01',-1,'REGULAR','SUV'),(6,'P02',-1,'REGULAR','CAR'),(6,'P03',-1,'REGULAR','CAR'),
 (6,'E01',-1,'EV','SUV'),(6,'E02',-1,'EV','CAR');

-- Helper (temporary, disappears at end of session): slot id from location + code
CREATE OR REPLACE FUNCTION pg_temp.slot(p_loc INTEGER, p_code TEXT) RETURNS INTEGER
LANGUAGE sql AS $$ SELECT slot_id FROM parking.parking_slots WHERE location_id = p_loc AND slot_code = p_code $$;
CREATE OR REPLACE FUNCTION pg_temp.veh(p_reg TEXT) RETURNS INTEGER
LANGUAGE sql AS $$ SELECT vehicle_id FROM parking.vehicles WHERE registration_no = p_reg $$;

-- ---------------------------------------------------------------------
-- Chargers (one per EV slot) — AC and DC, different power ratings
-- ---------------------------------------------------------------------
INSERT INTO chargers (slot_id, charger_type, connector_type, power_kw, installed_on) VALUES
 (pg_temp.slot(1,'E01'), 'AC', 'TYPE2',         7.4, '2024-02-10'),
 (pg_temp.slot(1,'E02'), 'AC', 'TYPE2',        22.0, '2024-02-10'),
 (pg_temp.slot(1,'E03'), 'DC', 'CCS2',         60.0, '2024-06-01'),
 (pg_temp.slot(2,'E01'), 'DC', 'CCS2',         30.0, '2023-11-15'),
 (pg_temp.slot(2,'E02'), 'AC', 'BHARAT_AC001',  3.3, '2022-08-20'),
 (pg_temp.slot(2,'E03'), 'DC', 'CHADEMO',      50.0, '2023-11-15'),
 (pg_temp.slot(3,'E01'), 'DC', 'CCS2',         60.0, '2025-01-05'),
 (pg_temp.slot(3,'E02'), 'DC', 'CCS2',         30.0, '2025-01-05'),
 (pg_temp.slot(4,'E01'), 'AC', 'TYPE2',         7.4, '2024-07-22'),
 (pg_temp.slot(4,'E02'), 'AC', 'TYPE2',         7.4, '2024-07-22'),
 (pg_temp.slot(4,'E03'), 'DC', 'CCS2',         30.0, '2025-03-14'),
 (pg_temp.slot(5,'E01'), 'DC', 'CCS2',         60.0, '2024-09-09'),
 (pg_temp.slot(5,'E02'), 'AC', 'TYPE2',        22.0, '2024-09-09'),
 (pg_temp.slot(5,'E03'), 'DC', 'CCS2',        120.0, '2025-05-30'),
 (pg_temp.slot(6,'E01'), 'DC', 'CCS2',         50.0, '2024-04-18'),
 (pg_temp.slot(6,'E02'), 'AC', 'TYPE2',         7.4, '2024-04-18');

-- ---------------------------------------------------------------------
-- Pricing (₹ per hour). NULL location = default for every location.
-- ---------------------------------------------------------------------
INSERT INTO pricing_rules (location_id, applies_to, rate_per_hour, description) VALUES
 (NULL, 'PARKING',  40.00, 'Default parking rate'),
 (NULL, 'AC',       60.00, 'Default AC (slow) charging surcharge'),
 (NULL, 'DC',      150.00, 'Default DC fast-charging surcharge'),
 (2,    'PARKING',  60.00, 'Express Avenue — premium mall parking'),
 (4,    'PARKING',  20.00, 'VIT Chennai — subsidised campus parking'),
 (4,    'AC',       40.00, 'VIT Chennai — subsidised AC charging'),
 (5,    'PARKING',  50.00, 'Orion Mall parking'),
 (6,    'PARKING',  80.00, 'Lower Parel — high-demand area'),
 (6,    'DC',      180.00, 'Lower Parel — DC fast charging');

INSERT INTO peak_hours (label, day_type, start_time, end_time, multiplier) VALUES
 ('Weekday morning rush', 'WEEKDAY', '08:00', '11:00', 1.50),
 ('Evening rush',         'ALL',     '17:00', '21:00', 1.50),
 ('Weekend shopping',     'WEEKEND', '11:00', '17:00', 1.25);

-- ---------------------------------------------------------------------
-- Reservations
--   anchor 'H' = start of the current hour
--   anchor 'T' = midnight at the start of TOMORROW, India time
--   final  = status the row should end up in
-- ---------------------------------------------------------------------
CREATE TEMP TABLE seed_res (
    n          INTEGER PRIMARY KEY,
    reg        TEXT, loc INTEGER, code TEXT,
    anchor     CHAR(1), start_off INTERVAL, dur INTERVAL,
    final      TEXT,
    checkout_off INTERVAL,          -- check-out time relative to end_time
    method     TEXT,                -- booking payment method (NULL = unpaid)
    fine_paid  BOOLEAN DEFAULT FALSE,
    reason     TEXT
);

INSERT INTO seed_res VALUES
 -- ---- history: COMPLETED -----------------------------------------
 ( 1,'TN09AB1234',1,'E03','H','-240 hours','2 hours','COMPLETED','-10 minutes','UPI',       FALSE,NULL),
 ( 2,'TN07EF2345',1,'E02','H','-200 hours','3 hours','COMPLETED','70 minutes', 'CARD',      TRUE, NULL),  -- overstay: fine
 ( 3,'KA03MX4521',2,'B01','H','-150 hours','2 hours','COMPLETED','10 minutes', 'UPI',       FALSE,NULL),  -- inside grace: no fine
 ( 4,'MH01VS9090',1,'A05','H','-100 hours','4 hours','COMPLETED','150 minutes','NETBANKING',FALSE,NULL),  -- overstay: fine UNPAID
 ( 5,'KA05PR7788',5,'E01','H','-72 hours', '1 hour', 'COMPLETED','-5 minutes', 'WALLET',    FALSE,NULL),
 ( 6,'TN22KN3344',4,'E01','H','-48 hours', '2 hours','COMPLETED','20 minutes', 'UPI',       TRUE, NULL),  -- just past grace
 ( 7,'TN11KS7890',4,'V05','H','-30 hours', '3 hours','COMPLETED','0 minutes',  'UPI',       FALSE,NULL),
 -- ---- history: CANCELLED / EXPIRED / NO_SHOW ----------------------
 ( 8,'KA03MX4521',2,'B02','H','-20 hours', '2 hours','CANCELLED',NULL,'UPI',  FALSE,'Change of plans'),
 ( 9,'MH02SP6655',2,'E03','T','34 hours',  '2 hours','CANCELLED',NULL,'CARD', FALSE,'Cancelled by user'),
 (10,'TN09DK4455',4,'E03','H','-5 hours',  '2 hours','EXPIRED',  NULL,NULL,   FALSE,'Payment not received before hold expired'),
 (11,'TN01MI1122',2,'E02','H','-26 hours', '2 hours','NO_SHOW',  NULL,'UPI',  FALSE,'Did not check in within the allowed window'),
 -- ---- happening NOW: CHECKED_IN (slot physically OCCUPIED) --------
 (12,'MH12DE1433',6,'E01','H','-1 hour',   '3 hours','CHECKED_IN',NULL,'UPI', FALSE,NULL),
 (13,'KA03MX4521',1,'A01','H','-2 hours',  '4 hours','CHECKED_IN',NULL,'CARD',FALSE,NULL),
 -- ---- upcoming: CONFIRMED -----------------------------------------
 (14,'TN09AB1234',3,'E01','T','18 hours',  '2 hours','CONFIRMED',NULL,'UPI',  FALSE,NULL),  -- Central DC #1 (full)
 (15,'KA05PR7788',3,'E02','T','18 hours',  '2 hours','CONFIRMED',NULL,'CARD', FALSE,NULL),  -- Central DC #2 (full)
 (16,'TN07EF2345',1,'E01','T','10 hours',  '3 hours','CONFIRMED',NULL,'UPI',  FALSE,NULL),
 (17,'MH01VS9090',6,'P01','T','9 hours',   '8 hours','CONFIRMED',NULL,'NETBANKING',FALSE,NULL),
 -- ---- temporary HOLDS ---------------------------------------------
 (18,'TN09DK4455',5,'E02','T','14 hours',  '2 hours','HELD',     NULL,NULL,   FALSE,NULL),  -- hold still valid
 (19,'TN22KN3344',4,'E01','T','16 hours',  '2 hours','HELD',     NULL,NULL,   FALSE,NULL);  -- hold ALREADY expired (T10 demo)

-- Step 1: insert. COMPLETED rows go in as CHECKED_IN first so that the
-- UPDATE in step 2 fires trigger A (overstay fine) exactly like real life.
WITH anchors AS (
    SELECT date_trunc('hour', now()) AS h,
           (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day') AT TIME ZONE 'Asia/Kolkata' AS t
)
INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, status, source,
                          hold_expires_at, parking_fee, charging_fee, check_in_time, cancel_reason, created_at)
SELECT v.user_id, v.vehicle_id, s.slot_id,
       x.st, x.st + sr.dur,
       CASE sr.final WHEN 'COMPLETED' THEN 'CHECKED_IN' WHEN 'CHECKED_IN' THEN 'CONFIRMED' ELSE sr.final END,
       'DIRECT',
       CASE WHEN sr.n = 18 THEN now() + interval '8 minutes'
            WHEN sr.n = 19 THEN now() - interval '5 minutes'
            WHEN sr.final = 'EXPIRED' THEN x.st - interval '1 day' + interval '10 minutes' END,
       p.parking_fee, p.charging_fee,
       CASE WHEN sr.final = 'COMPLETED' THEN x.st + interval '5 minutes' END,
       sr.reason,
       CASE WHEN sr.final = 'HELD' AND sr.n = 18 THEN now() - interval '2 minutes'
            WHEN sr.final = 'HELD' THEN now() - interval '15 minutes'
            WHEN x.st < now() THEN x.st - interval '1 day'
            ELSE now() - interval '3 hours' END
FROM seed_res sr
CROSS JOIN anchors a
CROSS JOIN LATERAL (SELECT CASE sr.anchor WHEN 'H' THEN a.h ELSE a.t END + sr.start_off AS st) x
JOIN vehicles v       ON v.registration_no = sr.reg
JOIN parking_slots s  ON s.location_id = sr.loc AND s.slot_code = sr.code
LEFT JOIN chargers c  ON c.slot_id = s.slot_id
CROSS JOIN LATERAL fn_calculate_price(s.location_id, s.slot_type, c.charger_type, x.st, x.st + sr.dur) p
ORDER BY sr.n;            -- so reservation_id = n

-- Step 2: complete the history rows -> trigger A computes overstay fines,
-- trigger B keeps the slot FREE.
UPDATE reservations r
   SET status = 'COMPLETED', check_out_time = r.end_time + sr.checkout_off
  FROM seed_res sr
 WHERE sr.n = r.reservation_id AND sr.final = 'COMPLETED';

-- Step 3: check in the "now" rows -> trigger B marks their slots OCCUPIED.
UPDATE reservations r
   SET status = 'CHECKED_IN', check_in_time = r.start_time + interval '5 minutes'
  FROM seed_res sr
 WHERE sr.n = r.reservation_id AND sr.final = 'CHECKED_IN';

-- Step 4: payments (simulated)
INSERT INTO payments (reservation_id, amount, payment_type, method, status, transaction_ref, paid_at, refunded_at)
SELECT r.reservation_id, r.parking_fee + r.charging_fee, 'BOOKING', sr.method,
       CASE WHEN r.status = 'CANCELLED' THEN 'REFUNDED' ELSE 'SUCCESS' END,
       'SEED-' || lpad(r.reservation_id::text, 4, '0') || '-B',
       r.created_at + interval '2 minutes',
       CASE WHEN r.status = 'CANCELLED' THEN r.created_at + interval '1 hour' END
FROM reservations r JOIN seed_res sr ON sr.n = r.reservation_id
WHERE sr.method IS NOT NULL
ORDER BY r.reservation_id;

INSERT INTO payments (reservation_id, amount, payment_type, method, status, transaction_ref, paid_at)
SELECT r.reservation_id, r.overstay_fine, 'FINE', 'UPI', 'SUCCESS',
       'SEED-' || lpad(r.reservation_id::text, 4, '0') || '-F', r.check_out_time + interval '5 minutes'
FROM reservations r JOIN seed_res sr ON sr.n = r.reservation_id
WHERE sr.fine_paid AND r.overstay_fine > 0;

-- One failed payment attempt (shows FAILED status)
INSERT INTO payments (reservation_id, amount, payment_type, method, status, transaction_ref, paid_at)
SELECT 18, parking_fee + charging_fee, 'BOOKING', 'CARD', 'FAILED', 'SEED-0018-X', now() - interval '1 minute'
FROM reservations WHERE reservation_id = 18;

-- ---------------------------------------------------------------------
-- Waiting list — Chennai Central DC chargers are FULL tomorrow 18:00–20:00
-- Expected queue order:  Arjun (priority 3, accessibility)
--                        Meera (priority 1, asked first)
--                        Divya (priority 1, asked later)
-- ---------------------------------------------------------------------
INSERT INTO waiting_list (user_id, vehicle_id, location_id, slot_type, charger_type,
                          start_time, end_time, priority, requested_at)
SELECT v.user_id, v.vehicle_id, 3, 'EV', 'DC', r.start_time, r.end_time,
       fn_user_priority(v.user_id), now() - w.ago
FROM (VALUES ('TN07EF2345', interval '50 minutes'),
             ('MH12DE1433', interval '30 minutes'),
             ('TN09DK4455', interval '20 minutes')) w(reg, ago)
JOIN vehicles v ON v.registration_no = w.reg
CROSS JOIN (SELECT start_time, end_time FROM reservations WHERE reservation_id = 14) r;

-- A historical entry that expired (its time passed without a free slot)
INSERT INTO waiting_list (user_id, vehicle_id, location_id, slot_type, start_time, end_time,
                          priority, status, requested_at)
SELECT 12, pg_temp.veh('TN11KS7890'), 3, 'REGULAR',
       date_trunc('hour', now()) - interval '50 hours', date_trunc('hour', now()) - interval '48 hours',
       1, 'EXPIRED', date_trunc('hour', now()) - interval '52 hours';

-- ---------------------------------------------------------------------
-- Faulty chargers (via the procedure, so tickets + trigger C run)
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_vit_ac  INTEGER := (SELECT charger_id FROM chargers WHERE slot_id = pg_temp.slot(4,'E02'));
    v_orion_dc INTEGER := (SELECT charger_id FROM chargers WHERE slot_id = pg_temp.slot(5,'E03'));
BEGIN
    CALL sp_mark_charger_faulty(v_vit_ac,   'Display blank, not starting session', 1);
    CALL sp_mark_charger_faulty(v_orion_dc, 'Cooling fan failure — DC output disabled', 1);
END $$;

-- A past ticket that was already repaired
INSERT INTO charger_maintenance (charger_id, issue_description, reported_by, reported_at, resolved_at, resolution_note)
SELECT charger_id, 'Cable connector damaged', 1, now() - interval '20 days', now() - interval '18 days', 'Connector cable replaced'
FROM chargers WHERE slot_id = pg_temp.slot(1,'E02');

DROP TABLE seed_res;
ANALYZE;

-- Quick summary
SELECT 'users' AS table_name, count(*) FROM users UNION ALL
SELECT 'vehicles', count(*) FROM vehicles UNION ALL
SELECT 'locations', count(*) FROM locations UNION ALL
SELECT 'parking_slots', count(*) FROM parking_slots UNION ALL
SELECT 'chargers', count(*) FROM chargers UNION ALL
SELECT 'reservations', count(*) FROM reservations UNION ALL
SELECT 'waiting_list', count(*) FROM waiting_list UNION ALL
SELECT 'payments', count(*) FROM payments UNION ALL
SELECT 'charger_maintenance', count(*) FROM charger_maintenance;
