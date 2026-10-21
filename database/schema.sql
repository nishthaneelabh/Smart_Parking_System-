-- =====================================================================
-- Smart Parking & EV Charging Reservation System
-- FILE 1 of 7 : schema.sql  — tables, keys and constraints
--
-- Run order (see database/setup.sql):
--   schema.sql -> functions.sql -> procedures.sql -> triggers.sql
--   -> indexes.sql -> seed.sql -> scheduler.sql
--
-- Everything lives in its own schema called "parking", so this file can be
-- re-run at any time: it drops the schema and builds it again from scratch.
-- =====================================================================

-- btree_gist lets a GiST index combine "=" on an integer column with "&&"
-- (overlaps) on a time range. We need it for the EXCLUDE constraints below.
CREATE EXTENSION IF NOT EXISTS btree_gist;

SET client_min_messages = warning;   -- hide the long list of 'drop cascades to ...' notices
DROP SCHEMA IF EXISTS parking CASCADE;
RESET client_min_messages;
CREATE SCHEMA parking;

-- Make "parking" the default schema for this session and for every future
-- session on this database, so examiners can type  \dt  and see the tables.
SET search_path = parking, public;
DO $$
BEGIN
    EXECUTE format('ALTER DATABASE %I SET search_path = parking, public', current_database());
END $$;

-- ---------------------------------------------------------------------
-- 1. BOOKING_POLICY  (single-row configuration table)
--    All business rules that are numbers live here, not in code.
-- ---------------------------------------------------------------------
CREATE TABLE booking_policy (
    policy_id               SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (policy_id = 1),
    hold_minutes            INTEGER      NOT NULL DEFAULT 10  CHECK (hold_minutes BETWEEN 1 AND 60),
    waitlist_offer_minutes  INTEGER      NOT NULL DEFAULT 10  CHECK (waitlist_offer_minutes BETWEEN 1 AND 60),
    grace_minutes           INTEGER      NOT NULL DEFAULT 15  CHECK (grace_minutes BETWEEN 0 AND 120),
    overstay_multiplier     NUMERIC(4,2) NOT NULL DEFAULT 2.00 CHECK (overstay_multiplier >= 1),
    no_show_minutes         INTEGER      NOT NULL DEFAULT 30  CHECK (no_show_minutes BETWEEN 5 AND 240),
    early_checkin_minutes   INTEGER      NOT NULL DEFAULT 15  CHECK (early_checkin_minutes BETWEEN 0 AND 120),
    min_booking_minutes     INTEGER      NOT NULL DEFAULT 30  CHECK (min_booking_minutes >= 15),
    max_booking_hours       INTEGER      NOT NULL DEFAULT 24  CHECK (max_booking_hours BETWEEN 1 AND 72),
    max_advance_days        INTEGER      NOT NULL DEFAULT 30  CHECK (max_advance_days BETWEEN 1 AND 365),
    pricing_timezone        TEXT         NOT NULL DEFAULT 'Asia/Kolkata',
    CHECK (min_booking_minutes <= max_booking_hours * 60)
);
COMMENT ON TABLE booking_policy IS 'Single-row table of configurable business rules (hold time, grace period, overstay multiplier ...).';

-- ---------------------------------------------------------------------
-- 2. USERS
-- ---------------------------------------------------------------------
CREATE TABLE users (
    user_id                  INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name                VARCHAR(100) NOT NULL CHECK (length(trim(full_name)) >= 2),
    email                    VARCHAR(150) NOT NULL,
    phone                    VARCHAR(15)  NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),   -- Indian mobile number
    password_hash            TEXT         NOT NULL,
    role                     VARCHAR(10)  NOT NULL DEFAULT 'USER'     CHECK (role IN ('USER', 'ADMIN')),
    membership_tier          VARCHAR(10)  NOT NULL DEFAULT 'STANDARD' CHECK (membership_tier IN ('STANDARD', 'PREMIUM')),
    has_accessibility_permit BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT uq_users_phone UNIQUE (phone),
    CONSTRAINT ck_users_email_format CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
    CONSTRAINT ck_users_email_lower  CHECK (email = lower(email))
);

-- ---------------------------------------------------------------------
-- 3. VEHICLES  (one user owns many vehicles)
-- ---------------------------------------------------------------------
CREATE TABLE vehicles (
    vehicle_id       INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          INTEGER     NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    registration_no  VARCHAR(15) NOT NULL,
    vehicle_type     VARCHAR(10) NOT NULL DEFAULT 'CAR' CHECK (vehicle_type IN ('CAR', 'SUV', 'BIKE')),
    model_name       VARCHAR(60) NOT NULL,
    is_ev            BOOLEAN     NOT NULL DEFAULT FALSE,
    connector_type   VARCHAR(15) CHECK (connector_type IN ('TYPE2', 'CCS2', 'CHADEMO', 'BHARAT_AC001')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_vehicles_registration UNIQUE (registration_no),
    -- Indian number plate, stored without spaces, e.g. TN09AB1234
    CONSTRAINT ck_vehicles_registration CHECK (registration_no ~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$'),
    -- An EV must have a connector; a petrol/diesel vehicle must not.
    CONSTRAINT ck_vehicles_ev_connector CHECK ((is_ev AND connector_type IS NOT NULL) OR (NOT is_ev AND connector_type IS NULL))
);

-- ---------------------------------------------------------------------
-- 4. LOCATIONS
-- ---------------------------------------------------------------------
CREATE TABLE locations (
    location_id  INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    address      VARCHAR(250) NOT NULL,
    city         VARCHAR(60)  NOT NULL,
    pincode      CHAR(6)      NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'),
    latitude     NUMERIC(9,6) CHECK (latitude  BETWEEN -90  AND 90),
    longitude    NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_locations_name_city UNIQUE (name, city)
);

-- ---------------------------------------------------------------------
-- 5. PARKING_SLOTS
--    occupancy_status = CURRENT PHYSICAL state (is a car standing there now?)
--    It is maintained ONLY by trigger B on check-in / check-out.
--    Future availability is NOT stored here — it is computed from RESERVATIONS.
-- ---------------------------------------------------------------------
CREATE TABLE parking_slots (
    slot_id           INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location_id       INTEGER     NOT NULL REFERENCES locations(location_id) ON DELETE RESTRICT,
    slot_code         VARCHAR(10) NOT NULL,
    floor_level       SMALLINT    NOT NULL DEFAULT 0 CHECK (floor_level BETWEEN -5 AND 20),
    slot_type         VARCHAR(10) NOT NULL DEFAULT 'REGULAR' CHECK (slot_type IN ('REGULAR', 'EV')),
    size_class        VARCHAR(10) NOT NULL DEFAULT 'CAR' CHECK (size_class IN ('BIKE', 'CAR', 'SUV')),
    occupancy_status  VARCHAR(10) NOT NULL DEFAULT 'FREE' CHECK (occupancy_status IN ('FREE', 'OCCUPIED')),
    is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_slots_location_code UNIQUE (location_id, slot_code)
);

-- ---------------------------------------------------------------------
-- 6. CHARGERS  (exactly one charger per EV slot -> UNIQUE(slot_id))
--    status = is the charger usable?  (physical "in use" comes from the slot)
-- ---------------------------------------------------------------------
CREATE TABLE chargers (
    charger_id      INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slot_id         INTEGER      NOT NULL REFERENCES parking_slots(slot_id) ON DELETE CASCADE,
    charger_type    VARCHAR(2)   NOT NULL CHECK (charger_type IN ('AC', 'DC')),
    connector_type  VARCHAR(15)  NOT NULL CHECK (connector_type IN ('TYPE2', 'CCS2', 'CHADEMO', 'BHARAT_AC001')),
    power_kw        NUMERIC(5,1) NOT NULL CHECK (power_kw > 0 AND power_kw <= 350),
    status          VARCHAR(12)  NOT NULL DEFAULT 'OPERATIONAL' CHECK (status IN ('OPERATIONAL', 'FAULTY')),
    installed_on    DATE         NOT NULL DEFAULT CURRENT_DATE,
    CONSTRAINT uq_chargers_slot UNIQUE (slot_id),
    -- AC chargers are slow (<= 22 kW) and use AC plugs; DC fast chargers use DC plugs.
    CONSTRAINT ck_chargers_type_power CHECK (
        (charger_type = 'AC' AND power_kw <= 22  AND connector_type IN ('TYPE2', 'BHARAT_AC001')) OR
        (charger_type = 'DC' AND power_kw >= 15  AND connector_type IN ('CCS2', 'CHADEMO'))
    )
);

-- ---------------------------------------------------------------------
-- 7. CHARGER_MAINTENANCE  (fault tickets; resolved_at NULL = still open)
-- ---------------------------------------------------------------------
CREATE TABLE charger_maintenance (
    maintenance_id     INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    charger_id         INTEGER      NOT NULL REFERENCES chargers(charger_id) ON DELETE CASCADE,
    issue_description  VARCHAR(300) NOT NULL,
    reported_by        INTEGER      REFERENCES users(user_id) ON DELETE SET NULL,
    reported_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at        TIMESTAMPTZ,
    resolution_note    VARCHAR(300),
    CONSTRAINT ck_maintenance_resolved_after CHECK (resolved_at IS NULL OR resolved_at >= reported_at)
);

-- ---------------------------------------------------------------------
-- 8. PRICING_RULES  (hourly base rates, configurable per location)
--    location_id NULL = default rule used when a location has no own rule.
--    applies_to: PARKING = slot rent, AC / DC = extra charging fee per hour.
-- ---------------------------------------------------------------------
CREATE TABLE pricing_rules (
    rule_id         INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location_id     INTEGER      REFERENCES locations(location_id) ON DELETE CASCADE,
    applies_to      VARCHAR(10)  NOT NULL CHECK (applies_to IN ('PARKING', 'AC', 'DC')),
    rate_per_hour   NUMERIC(8,2) NOT NULL CHECK (rate_per_hour >= 0),
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    description     VARCHAR(150)
);

-- ---------------------------------------------------------------------
-- 9. PEAK_HOURS  (time windows where rates are multiplied)
-- ---------------------------------------------------------------------
CREATE TABLE peak_hours (
    peak_id      INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label        VARCHAR(40)  NOT NULL,
    day_type     VARCHAR(8)   NOT NULL DEFAULT 'ALL' CHECK (day_type IN ('ALL', 'WEEKDAY', 'WEEKEND')),
    start_time   TIME         NOT NULL,
    end_time     TIME         NOT NULL,
    multiplier   NUMERIC(4,2) NOT NULL CHECK (multiplier >= 1 AND multiplier <= 5),
    CONSTRAINT ck_peak_window CHECK (start_time < end_time)
);

-- ---------------------------------------------------------------------
-- 10. RESERVATIONS  — the heart of the system
--
-- Life cycle:
--   HELD ──pay──> CONFIRMED ──check-in──> CHECKED_IN ──check-out──> COMPLETED
--    │               │
--    │               ├─ user cancels ───> CANCELLED
--    │               └─ no check-in  ───> NO_SHOW
--    ├─ hold timer runs out ────────────> EXPIRED
--    └─ user cancels ───────────────────> CANCELLED
--
-- "Active" statuses (they block the slot for their time range):
--     HELD, CONFIRMED, CHECKED_IN
-- ---------------------------------------------------------------------
CREATE TABLE reservations (
    reservation_id   INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          INTEGER      NOT NULL REFERENCES users(user_id)          ON DELETE RESTRICT,
    vehicle_id       INTEGER      NOT NULL REFERENCES vehicles(vehicle_id)    ON DELETE RESTRICT,
    slot_id          INTEGER      NOT NULL REFERENCES parking_slots(slot_id)  ON DELETE RESTRICT,
    start_time       TIMESTAMPTZ  NOT NULL,
    end_time         TIMESTAMPTZ  NOT NULL,
    -- [start, end) : a booking ending at 10:00 does NOT clash with one starting at 10:00
    booking_period   TSTZRANGE    GENERATED ALWAYS AS (tstzrange(start_time, end_time, '[)')) STORED,
    status           VARCHAR(12)  NOT NULL DEFAULT 'HELD'
                     CHECK (status IN ('HELD', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'NO_SHOW')),
    source           VARCHAR(10)  NOT NULL DEFAULT 'DIRECT' CHECK (source IN ('DIRECT', 'WAITLIST')),
    hold_expires_at  TIMESTAMPTZ,
    parking_fee      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (parking_fee  >= 0),
    charging_fee     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (charging_fee >= 0),
    overstay_fine    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (overstay_fine >= 0),
    total_amount     NUMERIC(10,2) GENERATED ALWAYS AS (parking_fee + charging_fee + overstay_fine) STORED,
    check_in_time    TIMESTAMPTZ,
    check_out_time   TIMESTAMPTZ,
    cancel_reason    VARCHAR(200),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT ck_res_time_order    CHECK (end_time > start_time),
    CONSTRAINT ck_res_hold_needed   CHECK (status <> 'HELD' OR hold_expires_at IS NOT NULL),
    CONSTRAINT ck_res_checkin_time  CHECK (status NOT IN ('CHECKED_IN', 'COMPLETED') OR check_in_time IS NOT NULL),
    CONSTRAINT ck_res_checkout_time CHECK ((status = 'COMPLETED') = (check_out_time IS NOT NULL)),
    CONSTRAINT ck_res_checkout_after_checkin CHECK (check_out_time IS NULL OR check_out_time >= check_in_time),

    -- *** THE DOUBLE-BOOKING GUARANTEE ***
    -- No two ACTIVE reservations may have the same slot AND overlapping time ranges.
    -- PostgreSQL itself rejects the second row (SQLSTATE 23P01 exclusion_violation),
    -- even if application code has a bug.
    CONSTRAINT ex_res_no_slot_overlap EXCLUDE USING gist (
        slot_id WITH =, booking_period WITH &&
    ) WHERE (status IN ('HELD', 'CONFIRMED', 'CHECKED_IN')),

    -- One vehicle cannot be parked in two places at the same time.
    CONSTRAINT ex_res_no_vehicle_overlap EXCLUDE USING gist (
        vehicle_id WITH =, booking_period WITH &&
    ) WHERE (status IN ('HELD', 'CONFIRMED', 'CHECKED_IN'))
);

-- ---------------------------------------------------------------------
-- 11. WAITING_LIST  (priority queue)
--   priority: 1 STANDARD, 2 PREMIUM member, 3 accessibility permit,
--             4 SERVICE RECOVERY (booking cancelled because a charger broke)
--   status:   WAITING -> OFFERED -> ACCEPTED
--                             └──> EXPIRED (offer not paid in time)
--             WAITING -> EXPIRED (requested time passed) / CANCELLED (user left)
-- ---------------------------------------------------------------------
CREATE TABLE waiting_list (
    entry_id                INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id                 INTEGER     NOT NULL REFERENCES users(user_id)       ON DELETE CASCADE,
    vehicle_id              INTEGER     NOT NULL REFERENCES vehicles(vehicle_id) ON DELETE CASCADE,
    location_id             INTEGER     NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
    slot_type               VARCHAR(10) NOT NULL CHECK (slot_type IN ('REGULAR', 'EV')),
    charger_type            VARCHAR(2)  CHECK (charger_type IN ('AC', 'DC')),          -- NULL = any compatible
    start_time              TIMESTAMPTZ NOT NULL,
    end_time                TIMESTAMPTZ NOT NULL,
    requested_period        TSTZRANGE   GENERATED ALWAYS AS (tstzrange(start_time, end_time, '[)')) STORED,
    priority                SMALLINT    NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 4),
    status                  VARCHAR(10) NOT NULL DEFAULT 'WAITING'
                            CHECK (status IN ('WAITING', 'OFFERED', 'ACCEPTED', 'EXPIRED', 'CANCELLED')),
    requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    offered_reservation_id  INTEGER     REFERENCES reservations(reservation_id) ON DELETE SET NULL,
    offered_at              TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_wl_time_order    CHECK (end_time > start_time),
    CONSTRAINT ck_wl_charger_only_for_ev CHECK (slot_type = 'EV' OR charger_type IS NULL),
    CONSTRAINT ck_wl_offer_has_res CHECK (status NOT IN ('OFFERED', 'ACCEPTED') OR offered_reservation_id IS NOT NULL),
    CONSTRAINT uq_wl_offered_res   UNIQUE (offered_reservation_id),
    -- A vehicle may wait only once for any given time window.
    CONSTRAINT ex_wl_no_duplicate_wait EXCLUDE USING gist (
        vehicle_id WITH =, requested_period WITH &&
    ) WHERE (status IN ('WAITING', 'OFFERED'))
);

-- ---------------------------------------------------------------------
-- 12. PAYMENTS  (simulated — no real money moves)
-- ---------------------------------------------------------------------
CREATE TABLE payments (
    payment_id       INTEGER       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reservation_id   INTEGER       NOT NULL REFERENCES reservations(reservation_id) ON DELETE RESTRICT,
    amount           NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    payment_type     VARCHAR(10)   NOT NULL CHECK (payment_type IN ('BOOKING', 'FINE')),
    method           VARCHAR(12)   NOT NULL CHECK (method IN ('UPI', 'CARD', 'NETBANKING', 'WALLET')),
    status           VARCHAR(10)   NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS', 'FAILED', 'REFUNDED')),
    transaction_ref  VARCHAR(40)   NOT NULL,
    paid_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    refunded_at      TIMESTAMPTZ,
    CONSTRAINT uq_payments_txn_ref UNIQUE (transaction_ref),
    CONSTRAINT ck_payments_refund_time CHECK ((status = 'REFUNDED') = (refunded_at IS NOT NULL))
);

-- ---------------------------------------------------------------------
-- 13. AUDIT_LOGS  (written only by triggers)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
    log_id      BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name  VARCHAR(40)  NOT NULL,
    record_id   INTEGER      NOT NULL,
    action      VARCHAR(10)  NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_status  VARCHAR(20),
    new_status  VARCHAR(20),
    details     TEXT,
    changed_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
