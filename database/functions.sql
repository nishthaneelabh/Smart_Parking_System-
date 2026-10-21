-- =====================================================================
-- FILE 2 of 7 : functions.sql — views + PL/pgSQL functions
--
-- Error convention used by every function:
--   RAISE EXCEPTION with ERRCODE 'P0001', a human message, and a short
--   machine-readable code in HINT (e.g. HINT = 'SLOT_UNAVAILABLE').
--   The Flask backend reads the HINT and turns it into a JSON error.
-- =====================================================================
SET search_path = parking, public;

-- ---------------------------------------------------------------------
-- fn_raise(code, message)  — tiny helper so every error looks the same
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_raise(p_code TEXT, p_message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_message, HINT = p_code;
END $$;

-- ---------------------------------------------------------------------
-- fn_is_active_status(status) — the three statuses that block a slot
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_is_active_status(p_status TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT p_status IN ('HELD', 'CONFIRMED', 'CHECKED_IN');
$$;

-- =====================================================================
-- SECTION A : PRICING
-- =====================================================================

-- ---------------------------------------------------------------------
-- fn_get_rate(location_id, applies_to) -> ₹ per hour
--   Uses the location's own rule if one exists, otherwise the default
--   (location_id IS NULL) rule.  Raises NO_PRICING_RULE if neither exists.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_get_rate(p_location_id INTEGER, p_applies_to TEXT)
RETURNS NUMERIC LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_rate NUMERIC;
BEGIN
    SELECT rate_per_hour INTO v_rate
    FROM pricing_rules
    WHERE applies_to = p_applies_to
      AND is_active
      AND (location_id = p_location_id OR location_id IS NULL)
    ORDER BY location_id NULLS LAST          -- location-specific rule wins
    LIMIT 1;

    IF v_rate IS NULL THEN
        PERFORM fn_raise('NO_PRICING_RULE',
            format('No active pricing rule for %s at location %s', p_applies_to, p_location_id));
    END IF;
    RETURN v_rate;
END $$;

-- ---------------------------------------------------------------------
-- fn_peak_multiplier(ts) -> 1.00 off-peak, or the peak multiplier
--   The clock time is read in the policy time zone (Asia/Kolkata), so
--   "6 PM" means 6 PM in India regardless of the server's time zone.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_peak_multiplier(p_ts TIMESTAMPTZ)
RETURNS NUMERIC LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_local  TIMESTAMP;
    v_mult   NUMERIC;
BEGIN
    SELECT p_ts AT TIME ZONE pricing_timezone INTO v_local FROM booking_policy WHERE policy_id = 1;

    SELECT max(multiplier) INTO v_mult
    FROM peak_hours
    WHERE v_local::time >= start_time
      AND v_local::time <  end_time
      AND (day_type = 'ALL'
           OR (day_type = 'WEEKEND' AND extract(isodow FROM v_local) IN (6, 7))
           OR (day_type = 'WEEKDAY' AND extract(isodow FROM v_local) BETWEEN 1 AND 5));

    RETURN coalesce(v_mult, 1.00);
END $$;

-- ---------------------------------------------------------------------
-- fn_calculate_price(location, slot_type, charger_type, start, end)
--
--   Splits the booking into 15-minute pieces. Each piece is charged
--       hourly_rate × (minutes / 60) × peak_multiplier_at_that_moment
--   so a booking from 4 PM to 7 PM pays off-peak for 4–5 PM and peak
--   for 5–7 PM (with the default seed data).
--
--   parking_fee  = PARKING rate pieces
--   charging_fee = AC or DC rate pieces (only for EV slots)
--
-- Returns one row. Never trusts any price from the frontend.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_calculate_price(
    p_location_id   INTEGER,
    p_slot_type     TEXT,
    p_charger_type  TEXT,          -- 'AC', 'DC' or NULL for regular slots
    p_start         TIMESTAMPTZ,
    p_end           TIMESTAMPTZ)
RETURNS TABLE (parking_fee NUMERIC, charging_fee NUMERIC, total NUMERIC,
               peak_minutes INTEGER, offpeak_minutes INTEGER)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_park_rate   NUMERIC;
    v_charge_rate NUMERIC := 0;
BEGIN
    IF p_end <= p_start THEN
        PERFORM fn_raise('INVALID_TIME', 'End time must be after start time');
    END IF;

    v_park_rate := fn_get_rate(p_location_id, 'PARKING');
    IF p_slot_type = 'EV' THEN
        IF p_charger_type NOT IN ('AC', 'DC') OR p_charger_type IS NULL THEN
            PERFORM fn_raise('INVALID_CHARGER', 'EV slot price needs charger type AC or DC');
        END IF;
        v_charge_rate := fn_get_rate(p_location_id, p_charger_type);
    END IF;

    RETURN QUERY
    WITH pieces AS (
        SELECT gs AS piece_start,
               extract(epoch FROM (least(gs + interval '15 minutes', p_end) - gs)) / 60.0 AS minutes,
               fn_peak_multiplier(gs) AS mult
        FROM generate_series(p_start, p_end - interval '1 microsecond', interval '15 minutes') AS gs
    )
    SELECT round(sum(v_park_rate   * minutes / 60.0 * mult), 2),
           round(sum(v_charge_rate * minutes / 60.0 * mult), 2),
           round(sum(v_park_rate   * minutes / 60.0 * mult), 2)
             + round(sum(v_charge_rate * minutes / 60.0 * mult), 2),
           coalesce(sum(minutes) FILTER (WHERE mult > 1), 0)::INTEGER,
           coalesce(sum(minutes) FILTER (WHERE mult = 1), 0)::INTEGER
    FROM pieces;
END $$;

-- =====================================================================
-- SECTION B : AVAILABILITY SEARCH
-- =====================================================================

-- ---------------------------------------------------------------------
-- fn_slot_size_rank: BIKE(1) < CAR(2) < SUV(3). A vehicle fits a slot
-- when vehicle rank <= slot rank.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_size_rank(p_size TEXT)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_size WHEN 'BIKE' THEN 1 WHEN 'CAR' THEN 2 WHEN 'SUV' THEN 3 END;
$$;

-- ---------------------------------------------------------------------
-- fn_connector_compatible(vehicle_plug, charger_plug)
--   Same plug always works. A CCS2 car can also use a Type 2 AC charger,
--   because the CCS2 socket contains the Type 2 pins.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_connector_compatible(p_vehicle TEXT, p_charger TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT p_vehicle = p_charger OR (p_vehicle = 'CCS2' AND p_charger = 'TYPE2');
$$;

-- ---------------------------------------------------------------------
-- fn_search_available_slots(...)
--   FUTURE availability: a slot is listed when no ACTIVE reservation
--   overlaps [start, end).  A HELD reservation whose hold already ran out
--   does not block (it will be expired by the scheduler).
--   Slots with a FAULTY charger are never listed.
--   Every filter parameter is optional (NULL = no filter).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_search_available_slots(
    p_start         TIMESTAMPTZ,
    p_end           TIMESTAMPTZ,
    p_location_id   INTEGER DEFAULT NULL,
    p_city          TEXT    DEFAULT NULL,
    p_slot_type     TEXT    DEFAULT NULL,
    p_charger_type  TEXT    DEFAULT NULL,
    p_vehicle_id    INTEGER DEFAULT NULL)
RETURNS TABLE (slot_id INTEGER, location_id INTEGER, location_name VARCHAR, city VARCHAR,
               slot_code VARCHAR, floor_level SMALLINT, slot_type VARCHAR, size_class VARCHAR,
               occupancy_status VARCHAR, charger_id INTEGER, charger_type VARCHAR,
               connector_type VARCHAR, power_kw NUMERIC,
               est_parking_fee NUMERIC, est_charging_fee NUMERIC, est_total NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_veh vehicles;
BEGIN
    IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
        PERFORM fn_raise('INVALID_TIME', 'Please choose a valid start and end time');
    END IF;
    IF p_vehicle_id IS NOT NULL THEN
        SELECT * INTO v_veh FROM vehicles v WHERE v.vehicle_id = p_vehicle_id;
    END IF;

    RETURN QUERY
    SELECT s.slot_id, s.location_id, l.name, l.city, s.slot_code, s.floor_level, s.slot_type,
           s.size_class, s.occupancy_status, c.charger_id, c.charger_type, c.connector_type,
           c.power_kw, p.parking_fee, p.charging_fee, p.total
    FROM parking_slots s
    JOIN locations l      ON l.location_id = s.location_id
    LEFT JOIN chargers c  ON c.slot_id = s.slot_id
    CROSS JOIN LATERAL fn_calculate_price(s.location_id, s.slot_type, c.charger_type, p_start, p_end) p
    WHERE s.is_active AND l.is_active
      AND (p_location_id  IS NULL OR s.location_id = p_location_id)
      AND (p_city         IS NULL OR l.city ILIKE p_city)
      AND (p_slot_type    IS NULL OR s.slot_type = p_slot_type)
      AND (p_charger_type IS NULL OR c.charger_type = p_charger_type)
      -- EV slots need a working charger
      AND (s.slot_type = 'REGULAR' OR (c.charger_id IS NOT NULL AND c.status = 'OPERATIONAL'))
      -- vehicle compatibility (only when a vehicle was given)
      AND (v_veh.vehicle_id IS NULL OR (
              fn_size_rank(v_veh.vehicle_type) <= fn_size_rank(s.size_class)
              AND (s.slot_type = 'REGULAR' OR (v_veh.is_ev AND fn_connector_compatible(v_veh.connector_type, c.connector_type)))))
      -- no overlapping active reservation
      AND NOT EXISTS (
            SELECT 1 FROM reservations r
            WHERE r.slot_id = s.slot_id
              AND r.status IN ('HELD', 'CONFIRMED', 'CHECKED_IN')
              AND r.booking_period && tstzrange(p_start, p_end, '[)')
              AND NOT (r.status = 'HELD' AND r.hold_expires_at <= now()))
    ORDER BY l.name, s.slot_type DESC, s.slot_code;
END $$;

-- =====================================================================
-- SECTION C : SAFE RESERVATION (the concurrency-critical function)
-- =====================================================================

-- ---------------------------------------------------------------------
-- fn_create_reservation(user, vehicle, slot, start, end, source, nowait)
--   RETURNS the new reservation_id (status HELD; pay before hold expires).
--
--   Concurrency strategy (two layers):
--   1. SELECT ... FOR UPDATE on the slot row. Two bookings of the SAME slot
--      are forced to run one after another. The second one waits, then sees
--      the first booking (READ COMMITTED takes a fresh snapshot for every
--      statement) and fails with SLOT_UNAVAILABLE.
--      With p_nowait = TRUE the second one does not wait at all and fails
--      immediately with SLOT_BUSY (FOR UPDATE NOWAIT).
--   2. The EXCLUDE constraint ex_res_no_slot_overlap. Even if someone
--      inserts rows directly without this function, PostgreSQL refuses an
--      overlapping active reservation.
--
--   Errors (HINT codes): INVALID_TIME, VEHICLE_NOT_OWNED, SLOT_NOT_FOUND,
--   SLOT_INACTIVE, VEHICLE_INCOMPATIBLE, CHARGER_FAULTY, SLOT_UNAVAILABLE,
--   VEHICLE_ALREADY_BOOKED, SLOT_BUSY.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_create_reservation(
    p_user_id     INTEGER,
    p_vehicle_id  INTEGER,
    p_slot_id     INTEGER,
    p_start       TIMESTAMPTZ,
    p_end         TIMESTAMPTZ,
    p_source      TEXT    DEFAULT 'DIRECT',
    p_nowait      BOOLEAN DEFAULT FALSE)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_pol        booking_policy;
    v_slot       parking_slots;
    v_loc_active BOOLEAN;
    v_veh        vehicles;
    v_ch         chargers;
    v_price      RECORD;
    v_hold_min   INTEGER;
    v_id         INTEGER;
    v_constraint TEXT;
BEGIN
    SELECT * INTO v_pol FROM booking_policy WHERE policy_id = 1;

    -- 1. Validate the requested time window --------------------------
    IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
        PERFORM fn_raise('INVALID_TIME', 'End time must be after start time');
    END IF;
    IF p_start < now() - interval '5 minutes' THEN
        PERFORM fn_raise('INVALID_TIME', 'Start time cannot be in the past');
    END IF;
    IF p_end - p_start < make_interval(mins => v_pol.min_booking_minutes) THEN
        PERFORM fn_raise('INVALID_TIME', format('Minimum booking is %s minutes', v_pol.min_booking_minutes));
    END IF;
    IF p_end - p_start > make_interval(hours => v_pol.max_booking_hours) THEN
        PERFORM fn_raise('INVALID_TIME', format('Maximum booking is %s hours', v_pol.max_booking_hours));
    END IF;
    IF p_start > now() + make_interval(days => v_pol.max_advance_days) THEN
        PERFORM fn_raise('INVALID_TIME', format('You can book at most %s days in advance', v_pol.max_advance_days));
    END IF;

    -- 2. The vehicle must belong to the user ---------------------------
    SELECT * INTO v_veh FROM vehicles WHERE vehicle_id = p_vehicle_id;
    IF NOT FOUND OR v_veh.user_id <> p_user_id THEN
        PERFORM fn_raise('VEHICLE_NOT_OWNED', 'This vehicle is not registered to your account');
    END IF;

    -- 3. LOCK THE SLOT ROW  (this is where concurrent bookers queue up) --
    IF p_nowait THEN
        SELECT * INTO v_slot FROM parking_slots WHERE slot_id = p_slot_id FOR UPDATE NOWAIT;
    ELSE
        SELECT * INTO v_slot FROM parking_slots WHERE slot_id = p_slot_id FOR UPDATE;
    END IF;
    IF NOT FOUND THEN
        PERFORM fn_raise('SLOT_NOT_FOUND', format('Slot %s does not exist', p_slot_id));
    END IF;

    SELECT is_active INTO v_loc_active FROM locations WHERE location_id = v_slot.location_id;
    IF NOT v_slot.is_active OR NOT v_loc_active THEN
        PERFORM fn_raise('SLOT_INACTIVE', 'This slot is currently closed for bookings');
    END IF;
    IF fn_size_rank(v_veh.vehicle_type) > fn_size_rank(v_slot.size_class) THEN
        PERFORM fn_raise('VEHICLE_INCOMPATIBLE',
            format('A %s does not fit in a %s-size slot', v_veh.vehicle_type, v_slot.size_class));
    END IF;

    -- 4. EV slots: charger must work and match the car's plug ----------
    IF v_slot.slot_type = 'EV' THEN
        -- FOR SHARE: an admin cannot flip the charger to FAULTY until we commit
        SELECT * INTO v_ch FROM chargers WHERE slot_id = p_slot_id FOR SHARE;
        IF NOT FOUND THEN
            PERFORM fn_raise('CHARGER_FAULTY', 'This EV slot has no charger installed');
        END IF;
        IF v_ch.status <> 'OPERATIONAL' THEN
            PERFORM fn_raise('CHARGER_FAULTY', 'The charger at this slot is faulty and cannot be booked');
        END IF;
        IF NOT v_veh.is_ev THEN
            PERFORM fn_raise('VEHICLE_INCOMPATIBLE', 'EV charging slots are reserved for electric vehicles');
        END IF;
        IF NOT fn_connector_compatible(v_veh.connector_type, v_ch.connector_type) THEN
            PERFORM fn_raise('VEHICLE_INCOMPATIBLE',
                format('Your vehicle uses %s but this charger has %s', v_veh.connector_type, v_ch.connector_type));
        END IF;
    END IF;

    -- 5. Release holds on this slot whose payment window has passed ----
    UPDATE reservations
       SET status = 'EXPIRED', cancel_reason = 'Payment not received before hold expired'
     WHERE slot_id = p_slot_id AND status = 'HELD' AND hold_expires_at <= now();

    -- 6. Check the LATEST reservations (fresh snapshot after the lock) --
    IF EXISTS (SELECT 1 FROM reservations
               WHERE slot_id = p_slot_id
                 AND status IN ('HELD', 'CONFIRMED', 'CHECKED_IN')
                 AND booking_period && tstzrange(p_start, p_end, '[)')) THEN
        PERFORM fn_raise('SLOT_UNAVAILABLE', 'Slot Unavailable: it is already reserved for an overlapping time');
    END IF;
    IF EXISTS (SELECT 1 FROM reservations
               WHERE vehicle_id = p_vehicle_id
                 AND status IN ('HELD', 'CONFIRMED', 'CHECKED_IN')
                 AND NOT (status = 'HELD' AND hold_expires_at <= now())
                 AND booking_period && tstzrange(p_start, p_end, '[)')) THEN
        PERFORM fn_raise('VEHICLE_ALREADY_BOOKED', 'This vehicle already has a reservation during this time');
    END IF;

    -- 7. Price is calculated here, in the database ---------------------
    SELECT * INTO v_price
    FROM fn_calculate_price(v_slot.location_id, v_slot.slot_type, v_ch.charger_type, p_start, p_end);

    v_hold_min := CASE WHEN p_source = 'WAITLIST' THEN v_pol.waitlist_offer_minutes ELSE v_pol.hold_minutes END;

    -- 8. Insert the temporary hold ------------------------------------
    INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, status, source,
                              hold_expires_at, parking_fee, charging_fee)
    VALUES (p_user_id, p_vehicle_id, p_slot_id, p_start, p_end, 'HELD', p_source,
            now() + make_interval(mins => v_hold_min), v_price.parking_fee, v_price.charging_fee)
    RETURNING reservation_id INTO v_id;

    RETURN v_id;

EXCEPTION
    WHEN lock_not_available THEN          -- only possible with NOWAIT
        PERFORM fn_raise('SLOT_BUSY', 'Another user is booking this slot right now. Please try again.');
    WHEN exclusion_violation THEN         -- safety net: the EXCLUDE constraint fired
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint = 'ex_res_no_vehicle_overlap' THEN
            PERFORM fn_raise('VEHICLE_ALREADY_BOOKED', 'This vehicle already has a reservation during this time');
        END IF;
        PERFORM fn_raise('SLOT_UNAVAILABLE', 'Slot Unavailable: it is already reserved for an overlapping time');
END $$;

-- =====================================================================
-- SECTION D : PAYMENT, CANCELLATION, CHECK-IN, CHECK-OUT, BILLING
-- =====================================================================

-- ---------------------------------------------------------------------
-- fn_final_bill(reservation) -> one row with the full bill
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_final_bill(p_reservation_id INTEGER)
RETURNS TABLE (reservation_id INTEGER, status VARCHAR, parking_fee NUMERIC, charging_fee NUMERIC,
               overstay_fine NUMERIC, total_amount NUMERIC, amount_paid NUMERIC,
               amount_refunded NUMERIC, balance_due NUMERIC, overstay_minutes INTEGER)
LANGUAGE sql STABLE AS $$
    SELECT r.reservation_id, r.status, r.parking_fee, r.charging_fee, r.overstay_fine, r.total_amount,
           coalesce(sum(p.amount) FILTER (WHERE p.status = 'SUCCESS'), 0),
           coalesce(sum(p.amount) FILTER (WHERE p.status = 'REFUNDED'), 0),
           CASE WHEN r.status IN ('CANCELLED', 'EXPIRED') THEN 0
                ELSE greatest(r.total_amount - coalesce(sum(p.amount) FILTER (WHERE p.status = 'SUCCESS'), 0), 0)
           END,
           CASE WHEN r.check_out_time > r.end_time
                THEN ceil(extract(epoch FROM r.check_out_time - r.end_time) / 60)::INTEGER
                ELSE 0 END
    FROM reservations r
    LEFT JOIN payments p ON p.reservation_id = r.reservation_id
    WHERE r.reservation_id = p_reservation_id
    GROUP BY r.reservation_id;
$$;

-- ---------------------------------------------------------------------
-- fn_make_payment(reservation, user, method, is_admin, simulate_failure)
--   HELD      -> pays parking+charging, reservation becomes CONFIRMED
--   COMPLETED -> pays the remaining balance (overstay fine)
--   The amount is ALWAYS taken from the database, never from the client.
--   Returns payment_id (or NULL if nothing needed paying, e.g. ₹0 booking).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_make_payment(
    p_reservation_id   INTEGER,
    p_user_id          INTEGER,
    p_method           TEXT,
    p_is_admin         BOOLEAN DEFAULT FALSE,
    p_simulate_failure BOOLEAN DEFAULT FALSE)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_res      reservations;
    v_amount   NUMERIC;
    v_type     TEXT;
    v_pay_id   INTEGER;
    v_ref      TEXT := 'SIM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
BEGIN
    IF p_method NOT IN ('UPI', 'CARD', 'NETBANKING', 'WALLET') OR p_method IS NULL THEN
        PERFORM fn_raise('INVALID_METHOD', 'Choose UPI, CARD, NETBANKING or WALLET');
    END IF;

    SELECT * INTO v_res FROM reservations WHERE reservation_id = p_reservation_id FOR UPDATE;
    IF NOT FOUND OR (v_res.user_id <> p_user_id AND NOT p_is_admin) THEN
        PERFORM fn_raise('RESERVATION_NOT_FOUND', 'Reservation not found');
    END IF;

    IF v_res.status = 'HELD' THEN
        IF v_res.hold_expires_at <= now() THEN
            PERFORM fn_raise('HOLD_EXPIRED', 'Your hold has expired. Please search and book again.');
        END IF;
        v_amount := v_res.parking_fee + v_res.charging_fee;
        v_type   := 'BOOKING';
    ELSIF v_res.status = 'COMPLETED' THEN
        SELECT balance_due INTO v_amount FROM fn_final_bill(p_reservation_id);
        IF v_amount <= 0 THEN
            PERFORM fn_raise('NOTHING_TO_PAY', 'This reservation has no outstanding balance');
        END IF;
        v_type := 'FINE';
    ELSE
        PERFORM fn_raise('INVALID_STATE', format('Cannot pay for a reservation in status %s', v_res.status));
    END IF;

    IF p_simulate_failure THEN
        INSERT INTO payments (reservation_id, amount, payment_type, method, status, transaction_ref)
        VALUES (p_reservation_id, greatest(v_amount, 0.01), v_type, p_method, 'FAILED', v_ref)
        RETURNING payment_id INTO v_pay_id;
        RETURN v_pay_id;                                  -- reservation stays HELD
    END IF;

    IF v_amount > 0 THEN
        INSERT INTO payments (reservation_id, amount, payment_type, method, status, transaction_ref)
        VALUES (p_reservation_id, v_amount, v_type, p_method, 'SUCCESS', v_ref)
        RETURNING payment_id INTO v_pay_id;
    END IF;

    IF v_res.status = 'HELD' THEN
        UPDATE reservations SET status = 'CONFIRMED' WHERE reservation_id = p_reservation_id;
    END IF;
    RETURN v_pay_id;
END $$;

-- ---------------------------------------------------------------------
-- fn_cancel_reservation(reservation, user, is_admin, reason)
--   Allowed for HELD or CONFIRMED reservations that have not started.
--   Policy: every successful payment is refunded in full.
--   After cancelling, the waiting list is processed so the freed time
--   can be offered to the next person in the queue.
--   Returns the refunded amount.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_cancel_reservation(
    p_reservation_id INTEGER,
    p_user_id        INTEGER,
    p_is_admin       BOOLEAN DEFAULT FALSE,
    p_reason         TEXT    DEFAULT 'Cancelled by user')
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE
    v_res    reservations;
    v_refund NUMERIC := 0;
BEGIN
    SELECT * INTO v_res FROM reservations WHERE reservation_id = p_reservation_id FOR UPDATE;
    IF NOT FOUND OR (v_res.user_id <> p_user_id AND NOT p_is_admin) THEN
        PERFORM fn_raise('RESERVATION_NOT_FOUND', 'Reservation not found');
    END IF;
    IF v_res.status NOT IN ('HELD', 'CONFIRMED') THEN
        PERFORM fn_raise('CANNOT_CANCEL', format('A %s reservation cannot be cancelled', v_res.status));
    END IF;
    IF v_res.start_time <= now() AND NOT p_is_admin THEN
        PERFORM fn_raise('CANNOT_CANCEL', 'This reservation has already started and can no longer be cancelled');
    END IF;

    UPDATE reservations
       SET status = 'CANCELLED', cancel_reason = coalesce(p_reason, 'Cancelled')
     WHERE reservation_id = p_reservation_id;

    WITH refunded AS (
        UPDATE payments SET status = 'REFUNDED', refunded_at = now()
         WHERE reservation_id = p_reservation_id AND status = 'SUCCESS'
        RETURNING amount)
    SELECT coalesce(sum(amount), 0) INTO v_refund FROM refunded;

    PERFORM fn_process_waiting_list();
    RETURN v_refund;
END $$;

-- ---------------------------------------------------------------------
-- fn_check_in(reservation, user, is_admin)
--   Allowed for CONFIRMED reservations from (start - early_checkin_minutes)
--   until (start + no_show_minutes). The slot must be physically FREE —
--   if the previous driver is still there (overstaying) check-in is refused.
--   Trigger B then marks the slot OCCUPIED.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_check_in(
    p_reservation_id INTEGER,
    p_user_id        INTEGER,
    p_is_admin       BOOLEAN DEFAULT FALSE)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql AS $$
DECLARE
    v_res  reservations;
    v_pol  booking_policy;
    v_occ  TEXT;
BEGIN
    SELECT * INTO v_pol FROM booking_policy WHERE policy_id = 1;
    SELECT * INTO v_res FROM reservations WHERE reservation_id = p_reservation_id FOR UPDATE;
    IF NOT FOUND OR (v_res.user_id <> p_user_id AND NOT p_is_admin) THEN
        PERFORM fn_raise('RESERVATION_NOT_FOUND', 'Reservation not found');
    END IF;
    IF v_res.status <> 'CONFIRMED' THEN
        PERFORM fn_raise('INVALID_STATE', format('Only CONFIRMED reservations can check in (this one is %s)', v_res.status));
    END IF;
    IF now() < v_res.start_time - make_interval(mins => v_pol.early_checkin_minutes) THEN
        PERFORM fn_raise('TOO_EARLY', format('Check-in opens %s minutes before your start time', v_pol.early_checkin_minutes));
    END IF;
    IF now() > v_res.start_time + make_interval(mins => v_pol.no_show_minutes) THEN
        PERFORM fn_raise('TOO_LATE', 'The check-in window has closed (no-show)');
    END IF;

    SELECT occupancy_status INTO v_occ FROM parking_slots WHERE slot_id = v_res.slot_id FOR UPDATE;
    IF v_occ = 'OCCUPIED' THEN
        PERFORM fn_raise('SLOT_OCCUPIED', 'The previous vehicle has not left the slot yet. Please contact staff.');
    END IF;

    UPDATE reservations SET status = 'CHECKED_IN', check_in_time = now()
     WHERE reservation_id = p_reservation_id;
    RETURN now();
END $$;

-- ---------------------------------------------------------------------
-- fn_check_out(reservation, user, is_admin, checkout_time)
--   Sets status COMPLETED + check_out_time. Trigger A computes the
--   overstay fine, trigger B frees the slot. Returns the final bill.
--   p_checkout_time lets an ADMIN simulate a late checkout for the demo;
--   normal users always check out at now().
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_check_out(
    p_reservation_id INTEGER,
    p_user_id        INTEGER,
    p_is_admin       BOOLEAN     DEFAULT FALSE,
    p_checkout_time  TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE (reservation_id INTEGER, status VARCHAR, parking_fee NUMERIC, charging_fee NUMERIC,
               overstay_fine NUMERIC, total_amount NUMERIC, amount_paid NUMERIC,
               amount_refunded NUMERIC, balance_due NUMERIC, overstay_minutes INTEGER)
LANGUAGE plpgsql AS $$
DECLARE
    v_res  reservations;
    v_time TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_res FROM reservations r WHERE r.reservation_id = p_reservation_id FOR UPDATE;
    IF NOT FOUND OR (v_res.user_id <> p_user_id AND NOT p_is_admin) THEN
        PERFORM fn_raise('RESERVATION_NOT_FOUND', 'Reservation not found');
    END IF;
    IF v_res.status <> 'CHECKED_IN' THEN
        PERFORM fn_raise('INVALID_STATE', format('Only CHECKED_IN reservations can check out (this one is %s)', v_res.status));
    END IF;

    v_time := CASE WHEN p_is_admin AND p_checkout_time IS NOT NULL THEN p_checkout_time ELSE now() END;
    IF v_time < v_res.check_in_time THEN
        PERFORM fn_raise('INVALID_TIME', 'Check-out time cannot be before check-in time');
    END IF;

    UPDATE reservations r SET status = 'COMPLETED', check_out_time = v_time
     WHERE r.reservation_id = p_reservation_id;

    -- Leaving early frees the rest of the booked period -> offer it to the queue
    PERFORM fn_process_waiting_list();

    RETURN QUERY SELECT * FROM fn_final_bill(p_reservation_id);
END $$;

-- =====================================================================
-- SECTION E : PRIORITY WAITING LIST
-- =====================================================================

-- ---------------------------------------------------------------------
-- fn_user_priority(user) -> 1..3
--   3 = holds an accessibility permit, 2 = PREMIUM member, 1 = everyone else.
--   (4 = service recovery, assigned only by the faulty-charger trigger.)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_user_priority(p_user_id INTEGER)
RETURNS SMALLINT LANGUAGE sql STABLE AS $$
    SELECT (CASE WHEN has_accessibility_permit THEN 3
                 WHEN membership_tier = 'PREMIUM' THEN 2
                 ELSE 1 END)::SMALLINT
    FROM users WHERE user_id = p_user_id;
$$;

-- ---------------------------------------------------------------------
-- fn_join_waiting_list(...) -> entry_id
--   Only allowed when NO compatible slot is free for that time
--   (otherwise the user should simply book). Priority comes from the
--   user's profile — the client cannot choose it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_join_waiting_list(
    p_user_id       INTEGER,
    p_vehicle_id    INTEGER,
    p_location_id   INTEGER,
    p_slot_type     TEXT,
    p_charger_type  TEXT,
    p_start         TIMESTAMPTZ,
    p_end           TIMESTAMPTZ)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_veh   vehicles;
    v_free  INTEGER;
    v_id    INTEGER;
BEGIN
    IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
        PERFORM fn_raise('INVALID_TIME', 'End time must be after start time');
    END IF;
    IF p_start <= now() THEN
        PERFORM fn_raise('INVALID_TIME', 'You can only wait for a future time window');
    END IF;
    SELECT * INTO v_veh FROM vehicles WHERE vehicle_id = p_vehicle_id;
    IF NOT FOUND OR v_veh.user_id <> p_user_id THEN
        PERFORM fn_raise('VEHICLE_NOT_OWNED', 'This vehicle is not registered to your account');
    END IF;
    IF p_slot_type = 'EV' AND NOT v_veh.is_ev THEN
        PERFORM fn_raise('VEHICLE_INCOMPATIBLE', 'Only electric vehicles can wait for EV charging slots');
    END IF;
    IF p_slot_type = 'REGULAR' THEN
        p_charger_type := NULL;
    END IF;

    SELECT count(*) INTO v_free
    FROM fn_search_available_slots(p_start, p_end, p_location_id, NULL, p_slot_type, p_charger_type, p_vehicle_id);
    IF v_free > 0 THEN
        PERFORM fn_raise('SLOTS_AVAILABLE',
            format('%s compatible slot(s) are free for this time — please book directly', v_free));
    END IF;

    INSERT INTO waiting_list (user_id, vehicle_id, location_id, slot_type, charger_type,
                              start_time, end_time, priority)
    VALUES (p_user_id, p_vehicle_id, p_location_id, p_slot_type, p_charger_type,
            p_start, p_end, fn_user_priority(p_user_id))
    RETURNING entry_id INTO v_id;
    RETURN v_id;
EXCEPTION
    WHEN exclusion_violation THEN
        PERFORM fn_raise('ALREADY_WAITING', 'This vehicle is already on the waiting list for an overlapping time');
    WHEN foreign_key_violation THEN
        PERFORM fn_raise('LOCATION_NOT_FOUND', 'Unknown location');
END $$;

-- ---------------------------------------------------------------------
-- fn_process_waiting_list(max_offers) -> number of offers made
--
--   Queue order: priority DESC, requested_at ASC, entry_id ASC.
--   For each WAITING entry, look for a compatible free slot. If found,
--   create a WAITLIST reservation (status HELD = a temporary OFFER valid
--   for booking_policy.waitlist_offer_minutes). The user must pay within
--   that window, otherwise the hold expires and the entry is EXPIRED
--   (see trigger trg_res_waitlist_sync) and the next user gets a chance.
--
--   Two workers running at the same time cannot hand out the same slot:
--     * waiting_list rows are taken  FOR UPDATE SKIP LOCKED
--     * candidate slots are taken    FOR UPDATE SKIP LOCKED
--     * fn_create_reservation + the EXCLUDE constraint re-check overlaps
--   An entry whose request cannot be matched is skipped (it does not block
--   lower-priority users who want a different location/time).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_process_waiting_list(p_max_offers INTEGER DEFAULT 100)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_entry   waiting_list;
    v_cand    RECORD;
    v_res_id  INTEGER;
    v_hint    TEXT;
    v_offers  INTEGER := 0;
BEGIN
    FOR v_entry IN
        SELECT * FROM waiting_list
        WHERE status = 'WAITING' AND start_time > now()
        ORDER BY priority DESC, requested_at ASC, entry_id ASC
        FOR UPDATE SKIP LOCKED
    LOOP
        EXIT WHEN v_offers >= p_max_offers;
        v_res_id := NULL;

        FOR v_cand IN
            SELECT s.slot_id
            FROM parking_slots s
            JOIN locations l     ON l.location_id = s.location_id
            JOIN vehicles v      ON v.vehicle_id  = v_entry.vehicle_id
            LEFT JOIN chargers c ON c.slot_id     = s.slot_id
            WHERE s.location_id = v_entry.location_id
              AND s.slot_type   = v_entry.slot_type
              AND s.is_active AND l.is_active
              AND fn_size_rank(v.vehicle_type) <= fn_size_rank(s.size_class)
              AND (s.slot_type = 'REGULAR'
                   OR (c.status = 'OPERATIONAL' AND fn_connector_compatible(v.connector_type, c.connector_type)
                       AND (v_entry.charger_type IS NULL OR c.charger_type = v_entry.charger_type)))
              AND NOT EXISTS (SELECT 1 FROM reservations r
                              WHERE r.slot_id = s.slot_id
                                AND r.status IN ('HELD', 'CONFIRMED', 'CHECKED_IN')
                                AND NOT (r.status = 'HELD' AND r.hold_expires_at <= now())
                                AND r.booking_period && v_entry.requested_period)
            ORDER BY s.slot_id
            FOR UPDATE OF s SKIP LOCKED
        LOOP
            BEGIN
                v_res_id := fn_create_reservation(v_entry.user_id, v_entry.vehicle_id, v_cand.slot_id,
                                                  v_entry.start_time, v_entry.end_time, 'WAITLIST');
                EXIT;                                  -- got one
            EXCEPTION WHEN raise_exception THEN
                GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
                IF v_hint = 'VEHICLE_ALREADY_BOOKED' THEN
                    -- user already booked something else for this time -> leave the queue
                    UPDATE waiting_list SET status = 'CANCELLED' WHERE entry_id = v_entry.entry_id;
                    EXIT;
                END IF;
                -- any other reason: try the next candidate slot
            END;
        END LOOP;

        IF v_res_id IS NOT NULL THEN
            UPDATE waiting_list
               SET status = 'OFFERED', offered_reservation_id = v_res_id, offered_at = now()
             WHERE entry_id = v_entry.entry_id;
            v_offers := v_offers + 1;
        END IF;
    END LOOP;
    RETURN v_offers;
END $$;

-- =====================================================================
-- SECTION F : AUTOMATED EXPIRY (called by the scheduler)
-- =====================================================================

-- ---------------------------------------------------------------------
-- fn_run_expiry_jobs() -> counts of what changed
--   1. HELD reservations past hold_expires_at        -> EXPIRED
--   2. CONFIRMED, never checked in, start + no_show  -> NO_SHOW (no refund)
--   3. WAITING entries whose start time has passed   -> EXPIRED
--   4. Process the waiting list for freed capacity.
--   Safe to run any number of times: each step only touches rows still in
--   the "before" status, and SKIP LOCKED avoids fighting a booking that is
--   in progress.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_run_expiry_jobs()
RETURNS TABLE (expired_holds INTEGER, no_shows INTEGER, expired_waits INTEGER, offers_made INTEGER)
LANGUAGE plpgsql AS $$
DECLARE
    v_noshow INTEGER;
BEGIN
    SELECT no_show_minutes INTO v_noshow FROM booking_policy WHERE policy_id = 1;

    WITH due AS (
        SELECT reservation_id FROM reservations
        WHERE status = 'HELD' AND hold_expires_at <= now()
        FOR UPDATE SKIP LOCKED),
    upd AS (
        UPDATE reservations r
           SET status = 'EXPIRED', cancel_reason = 'Payment not received before hold expired'
          FROM due WHERE r.reservation_id = due.reservation_id
        RETURNING 1)
    SELECT count(*) INTO expired_holds FROM upd;

    WITH due AS (
        SELECT reservation_id FROM reservations
        WHERE status = 'CONFIRMED' AND start_time + make_interval(mins => v_noshow) <= now()
        FOR UPDATE SKIP LOCKED),
    upd AS (
        UPDATE reservations r
           SET status = 'NO_SHOW', cancel_reason = 'Did not check in within the allowed window'
          FROM due WHERE r.reservation_id = due.reservation_id
        RETURNING 1)
    SELECT count(*) INTO no_shows FROM upd;

    WITH due AS (
        SELECT entry_id FROM waiting_list
        WHERE status = 'WAITING' AND start_time <= now()
        FOR UPDATE SKIP LOCKED),
    upd AS (
        UPDATE waiting_list w SET status = 'EXPIRED'
          FROM due WHERE w.entry_id = due.entry_id
        RETURNING 1)
    SELECT count(*) INTO expired_waits FROM upd;

    offers_made := fn_process_waiting_list();
    RETURN NEXT;
END $$;

-- =====================================================================
-- SECTION G : VIEWS (read-only helpers used by the web pages)
-- =====================================================================

CREATE OR REPLACE VIEW v_reservation_details AS
SELECT r.reservation_id, r.user_id, u.full_name, u.email,
       r.vehicle_id, v.registration_no, v.model_name,
       r.slot_id, s.slot_code, s.slot_type, s.floor_level,
       l.location_id, l.name AS location_name, l.city,
       c.charger_id, c.charger_type, c.connector_type, c.power_kw,
       r.start_time, r.end_time, r.status, r.source, r.hold_expires_at,
       r.parking_fee, r.charging_fee, r.overstay_fine, r.total_amount,
       r.check_in_time, r.check_out_time, r.cancel_reason, r.created_at
FROM reservations r
JOIN users u          ON u.user_id = r.user_id
JOIN vehicles v       ON v.vehicle_id = r.vehicle_id
JOIN parking_slots s  ON s.slot_id = r.slot_id
JOIN locations l      ON l.location_id = s.location_id
LEFT JOIN chargers c  ON c.slot_id = s.slot_id;

-- Queue position is computed, never stored (so it can never be out of date).
CREATE OR REPLACE VIEW v_waiting_queue AS
SELECT w.*, u.full_name, v.registration_no, l.name AS location_name,
       CASE w.priority WHEN 4 THEN 'SERVICE RECOVERY' WHEN 3 THEN 'ACCESSIBILITY'
                       WHEN 2 THEN 'PREMIUM' ELSE 'STANDARD' END AS priority_label,
       CASE WHEN w.status = 'WAITING' THEN
            row_number() OVER (PARTITION BY (w.status = 'WAITING')
                               ORDER BY w.priority DESC, w.requested_at, w.entry_id)
       END AS queue_position,
       r.hold_expires_at AS offer_expires_at
FROM waiting_list w
JOIN users u     ON u.user_id = w.user_id
JOIN vehicles v  ON v.vehicle_id = w.vehicle_id
JOIN locations l ON l.location_id = w.location_id
LEFT JOIN reservations r ON r.reservation_id = w.offered_reservation_id;

-- One row per slot: physical state now + the next upcoming booking.
CREATE OR REPLACE VIEW v_slot_overview AS
SELECT s.slot_id, s.slot_code, s.slot_type, s.size_class, s.floor_level, s.occupancy_status,
       s.is_active, l.location_id, l.name AS location_name, l.city,
       c.charger_id, c.charger_type, c.connector_type, c.power_kw, c.status AS charger_status,
       (SELECT min(r.start_time) FROM reservations r
         WHERE r.slot_id = s.slot_id AND r.status IN ('HELD', 'CONFIRMED') AND r.start_time > now())
         AS next_reservation_at,
       (SELECT count(*) FROM reservations r
         WHERE r.slot_id = s.slot_id AND r.status IN ('HELD', 'CONFIRMED', 'CHECKED_IN')
           AND r.end_time > now()) AS upcoming_bookings
FROM parking_slots s
JOIN locations l     ON l.location_id = s.location_id
LEFT JOIN chargers c ON c.slot_id = s.slot_id;
