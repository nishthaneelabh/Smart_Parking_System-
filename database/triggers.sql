-- =====================================================================
-- FILE 4 of 7 : triggers.sql
--
--   Trigger A  trg_res_a_overstay_fine    BEFORE UPDATE on reservations
--   Trigger B  trg_res_slot_occupancy     AFTER  UPDATE on reservations
--   Trigger C  trg_charger_status_change  AFTER  UPDATE on chargers
--   plus supporting triggers:
--     trg_res_validate_insert   — blocks bookings on faulty chargers / closed slots
--     trg_res_waitlist_sync     — keeps WAITING_LIST in step with offers
--     trg_charger_slot_is_ev    — a charger can only sit on an EV slot
--     trg_slot_type_guard       — an EV slot with a charger cannot become REGULAR
--     trg_*_updated_at          — maintains updated_at
--     trg_audit_*               — writes AUDIT_LOGS
--
-- Avoiding recursion: no trigger writes back to the table that fired it,
-- except BEFORE triggers that only modify NEW. Chain of effects:
--   chargers ─(C)─> reservations ─(B)─> parking_slots   (no trigger there)
--                               └(sync)─> waiting_list (only the audit trigger)
-- so the chain always ends.
-- =====================================================================
SET search_path = parking, public;

-- ---------------------------------------------------------------------
-- Generic: updated_at = now()
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tf_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER trg_res_updated_at BEFORE UPDATE ON reservations
    FOR EACH ROW EXECUTE FUNCTION tf_set_updated_at();
CREATE TRIGGER trg_wl_updated_at BEFORE UPDATE ON waiting_list
    FOR EACH ROW EXECUTE FUNCTION tf_set_updated_at();

-- =====================================================================
-- TRIGGER A — OVERSTAY FINE
-- Fires: BEFORE UPDATE OF status on reservations, only when the status
--        changes to COMPLETED.
-- Rule : allowed exit = end_time + grace_minutes (default 15).
--        If the driver leaves later than that, EVERY started hour after
--        end_time is charged at  parking rate × overstay_multiplier (2×).
--        Example: booked till 12:00, rate ₹40/h, leaves 13:10
--                 -> 70 min late -> 2 started hours -> 2 × 40 × 2 = ₹160
-- =====================================================================
CREATE OR REPLACE FUNCTION tf_calculate_overstay_fine()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_pol       booking_policy;
    v_location  INTEGER;
    v_rate      NUMERIC;
    v_hours     INTEGER;
BEGIN
    IF NEW.check_out_time IS NULL THEN
        RAISE EXCEPTION 'check_out_time must be set when completing a reservation';
    END IF;

    SELECT * INTO v_pol FROM booking_policy WHERE policy_id = 1;

    IF NEW.check_out_time > NEW.end_time + make_interval(mins => v_pol.grace_minutes) THEN
        SELECT location_id INTO v_location FROM parking_slots WHERE slot_id = NEW.slot_id;
        v_rate  := fn_get_rate(v_location, 'PARKING');
        v_hours := ceil(extract(epoch FROM NEW.check_out_time - NEW.end_time) / 3600.0);
        NEW.overstay_fine := round(v_hours * v_rate * v_pol.overstay_multiplier, 2);
    ELSE
        NEW.overstay_fine := 0;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_res_a_overstay_fine
    BEFORE UPDATE OF status ON reservations
    FOR EACH ROW
    WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
    EXECUTE FUNCTION tf_calculate_overstay_fine();

-- =====================================================================
-- TRIGGER B — SLOT PHYSICAL OCCUPANCY
-- Fires: AFTER UPDATE OF status on reservations when the status changes.
--   -> CHECKED_IN                      : slot becomes OCCUPIED
--   CHECKED_IN -> COMPLETED/CANCELLED  : slot becomes FREE
-- A future reservation (HELD/CONFIRMED) NEVER changes occupancy_status.
-- Future availability is answered by fn_search_available_slots instead.
-- =====================================================================
CREATE OR REPLACE FUNCTION tf_update_slot_occupancy()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'CHECKED_IN' THEN
        UPDATE parking_slots SET occupancy_status = 'OCCUPIED'
         WHERE slot_id = NEW.slot_id AND occupancy_status <> 'OCCUPIED';
    ELSIF OLD.status = 'CHECKED_IN' THEN
        UPDATE parking_slots SET occupancy_status = 'FREE'
         WHERE slot_id = NEW.slot_id AND occupancy_status <> 'FREE';
    END IF;
    RETURN NULL;   -- return value of an AFTER trigger is ignored
END $$;

CREATE TRIGGER trg_res_slot_occupancy
    AFTER UPDATE OF status ON reservations
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status
          AND (NEW.status = 'CHECKED_IN' OR OLD.status = 'CHECKED_IN'))
    EXECUTE FUNCTION tf_update_slot_occupancy();

-- =====================================================================
-- TRIGGER C — FAULTY / REPAIRED CHARGER
-- Fires: AFTER UPDATE OF status on chargers when the status changes.
--
-- OPERATIONAL -> FAULTY  (documented policy)
--   1. Open a maintenance ticket if none is open.
--   2. Every HELD/CONFIRMED reservation on that slot that has not ended is
--      CANCELLED with reason "Charger fault", and its payments are
--      REFUNDED in full.
--   3. If the booking was still in the future, the driver is put on the
--      waiting list with priority 4 (SERVICE RECOVERY) for the same
--      location / charger type / time, so the queue can rebook them on
--      another working charger first.
--   4. CHECKED_IN sessions are left alone (the car is physically there;
--      staff handle it). New bookings are blocked by fn_create_reservation
--      and by trg_res_validate_insert.
--
-- FAULTY -> OPERATIONAL
--   Open maintenance tickets are closed. Because availability is always
--   calculated live, the slot is bookable again immediately. The calling
--   procedure (sp_mark_charger_repaired) then runs the waiting list.
-- =====================================================================
CREATE OR REPLACE FUNCTION tf_charger_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_res  RECORD;
    v_loc  INTEGER;
BEGIN
    IF NEW.status = 'FAULTY' THEN
        IF NOT EXISTS (SELECT 1 FROM charger_maintenance
                       WHERE charger_id = NEW.charger_id AND resolved_at IS NULL) THEN
            INSERT INTO charger_maintenance (charger_id, issue_description)
            VALUES (NEW.charger_id, 'Charger marked FAULTY');
        END IF;

        SELECT location_id INTO v_loc FROM parking_slots WHERE slot_id = NEW.slot_id;

        FOR v_res IN
            SELECT * FROM reservations
            WHERE slot_id = NEW.slot_id
              AND status IN ('HELD', 'CONFIRMED')
              AND end_time > now()
            FOR UPDATE
        LOOP
            UPDATE reservations
               SET status = 'CANCELLED',
                   cancel_reason = 'Charger fault — booking cancelled with full refund'
             WHERE reservation_id = v_res.reservation_id;

            UPDATE payments SET status = 'REFUNDED', refunded_at = now()
             WHERE reservation_id = v_res.reservation_id AND status = 'SUCCESS';

            IF v_res.start_time > now() THEN
                INSERT INTO waiting_list (user_id, vehicle_id, location_id, slot_type, charger_type,
                                          start_time, end_time, priority)
                VALUES (v_res.user_id, v_res.vehicle_id, v_loc, 'EV', NEW.charger_type,
                        v_res.start_time, v_res.end_time, 4)
                ON CONFLICT DO NOTHING;      -- already waiting for that time -> keep the old entry
            END IF;
        END LOOP;

    ELSIF OLD.status = 'FAULTY' AND NEW.status = 'OPERATIONAL' THEN
        UPDATE charger_maintenance
           SET resolved_at = now(),
               resolution_note = coalesce(resolution_note, 'Charger repaired')
         WHERE charger_id = NEW.charger_id AND resolved_at IS NULL;
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_charger_status_change
    AFTER UPDATE OF status ON chargers
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION tf_charger_status_change();

-- =====================================================================
-- Validation on INSERT of a reservation (defence in depth).
-- Even a hand-written INSERT cannot create an active booking on a closed
-- slot or a faulty charger.
-- =====================================================================
CREATE OR REPLACE FUNCTION tf_validate_reservation_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_slot_active BOOLEAN;
    v_ch_status   TEXT;
    v_slot_type   TEXT;
    v_owner       INTEGER;
BEGIN
    SELECT user_id INTO v_owner FROM vehicles WHERE vehicle_id = NEW.vehicle_id;
    IF v_owner IS DISTINCT FROM NEW.user_id THEN
        PERFORM fn_raise('VEHICLE_NOT_OWNED', 'Vehicle does not belong to this user');
    END IF;

    IF NOT fn_is_active_status(NEW.status) THEN
        RETURN NEW;                       -- historical rows (e.g. seed data) are allowed
    END IF;

    SELECT s.is_active, s.slot_type, c.status
      INTO v_slot_active, v_slot_type, v_ch_status
    FROM parking_slots s LEFT JOIN chargers c ON c.slot_id = s.slot_id
    WHERE s.slot_id = NEW.slot_id;

    IF NOT v_slot_active THEN
        PERFORM fn_raise('SLOT_INACTIVE', 'This slot is closed for bookings');
    END IF;
    IF v_slot_type = 'EV' AND v_ch_status IS DISTINCT FROM 'OPERATIONAL' THEN
        PERFORM fn_raise('CHARGER_FAULTY', 'The charger at this slot is faulty and cannot be booked');
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_res_validate_insert
    BEFORE INSERT ON reservations
    FOR EACH ROW EXECUTE FUNCTION tf_validate_reservation_insert();

-- =====================================================================
-- Waiting-list sync: when an OFFER (a WAITLIST reservation) changes state
--   CONFIRMED            -> entry ACCEPTED
--   EXPIRED              -> entry EXPIRED   (queue moves on to the next user)
--   CANCELLED            -> entry CANCELLED (user declined the offer)
-- =====================================================================
CREATE OR REPLACE FUNCTION tf_sync_waitlist_offer()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    UPDATE waiting_list
       SET status = CASE NEW.status WHEN 'CONFIRMED' THEN 'ACCEPTED'
                                    WHEN 'EXPIRED'   THEN 'EXPIRED'
                                    ELSE 'CANCELLED' END
     WHERE offered_reservation_id = NEW.reservation_id
       AND status = 'OFFERED';
    RETURN NULL;
END $$;

CREATE TRIGGER trg_res_waitlist_sync
    AFTER UPDATE OF status ON reservations
    FOR EACH ROW
    WHEN (NEW.source = 'WAITLIST' AND OLD.status = 'HELD'
          AND NEW.status IN ('CONFIRMED', 'EXPIRED', 'CANCELLED'))
    EXECUTE FUNCTION tf_sync_waitlist_offer();

-- =====================================================================
-- A charger may only be installed on an EV slot
-- =====================================================================
CREATE OR REPLACE FUNCTION tf_charger_slot_is_ev()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT slot_type FROM parking_slots WHERE slot_id = NEW.slot_id) IS DISTINCT FROM 'EV' THEN
        PERFORM fn_raise('NOT_EV_SLOT', format('Slot %s is not an EV slot', NEW.slot_id));
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_charger_slot_is_ev
    BEFORE INSERT OR UPDATE OF slot_id ON chargers
    FOR EACH ROW EXECUTE FUNCTION tf_charger_slot_is_ev();

CREATE OR REPLACE FUNCTION tf_slot_type_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.slot_type = 'REGULAR' AND EXISTS (SELECT 1 FROM chargers WHERE slot_id = NEW.slot_id) THEN
        PERFORM fn_raise('HAS_CHARGER', 'Remove the charger before turning this slot into a REGULAR slot');
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_slot_type_guard
    BEFORE UPDATE OF slot_type ON parking_slots
    FOR EACH ROW WHEN (OLD.slot_type IS DISTINCT FROM NEW.slot_type)
    EXECUTE FUNCTION tf_slot_type_guard();

-- =====================================================================
-- AUDIT LOG — one generic function, attached to four tables.
-- TG_ARGV[0] is the name of the primary-key column.
-- =====================================================================
CREATE OR REPLACE FUNCTION tf_audit_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_new JSONB := to_jsonb(NEW);
    v_old JSONB := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
BEGIN
    IF TG_OP = 'UPDATE' AND (v_old->>'status') IS NOT DISTINCT FROM (v_new->>'status') THEN
        RETURN NULL;
    END IF;
    INSERT INTO audit_logs (table_name, record_id, action, old_status, new_status, details)
    VALUES (TG_TABLE_NAME, (v_new->>TG_ARGV[0])::INTEGER, TG_OP,
            v_old->>'status', v_new->>'status',
            coalesce(v_new->>'cancel_reason', ''));
    RETURN NULL;
END $$;

CREATE TRIGGER trg_audit_reservations AFTER INSERT OR UPDATE OF status ON reservations
    FOR EACH ROW EXECUTE FUNCTION tf_audit_status('reservation_id');
CREATE TRIGGER trg_audit_chargers AFTER UPDATE OF status ON chargers
    FOR EACH ROW EXECUTE FUNCTION tf_audit_status('charger_id');
CREATE TRIGGER trg_audit_waiting_list AFTER INSERT OR UPDATE OF status ON waiting_list
    FOR EACH ROW EXECUTE FUNCTION tf_audit_status('entry_id');
CREATE TRIGGER trg_audit_payments AFTER INSERT OR UPDATE OF status ON payments
    FOR EACH ROW EXECUTE FUNCTION tf_audit_status('payment_id');
