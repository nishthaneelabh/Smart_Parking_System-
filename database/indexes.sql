-- =====================================================================
-- FILE 5 of 7 : indexes.sql
--
-- Indexes created AUTOMATICALLY by constraints in schema.sql (not repeated):
--   * every PRIMARY KEY            -> unique B-tree
--   * every UNIQUE constraint      -> unique B-tree (email, phone, plate, ...)
--   * ex_res_no_slot_overlap       -> GiST (slot_id, booking_period) WHERE active
--   * ex_res_no_vehicle_overlap    -> GiST (vehicle_id, booking_period) WHERE active
--   * ex_wl_no_duplicate_wait      -> GiST (vehicle_id, requested_period)
-- The GiST index on (slot_id, booking_period) is also what makes the
-- "is this slot free between X and Y?" check fast.
--
-- Note: PostgreSQL does NOT create indexes on foreign-key columns by
-- itself, so the important FK columns are indexed here.
-- See docs/Database_Schema.md §Indexing for EXPLAIN ANALYZE measurements.
-- =====================================================================
SET search_path = parking, public;

-- One active pricing rule per (location, kind). COALESCE turns the
-- "default" rule (location_id NULL) into 0 so it is unique as well.
CREATE UNIQUE INDEX uq_pricing_rules_active
    ON pricing_rules (coalesce(location_id, 0), applies_to) WHERE is_active;

-- Only one OPEN maintenance ticket per charger.
CREATE UNIQUE INDEX uq_maintenance_open_ticket
    ON charger_maintenance (charger_id) WHERE resolved_at IS NULL;

-- Location lookups: search by city (case-insensitive) on the browse page.
CREATE INDEX idx_locations_city ON locations (lower(city)) WHERE is_active;

-- Slot availability search: "all active EV slots at location 3".
CREATE INDEX idx_slots_location_type ON parking_slots (location_id, slot_type) WHERE is_active;

-- Charger status: admin "show faulty chargers", search filters by type.
CREATE INDEX idx_chargers_status ON chargers (status);
CREATE INDEX idx_chargers_type   ON chargers (charger_type, connector_type);

-- Reservation timestamps: admin list ordered by start, reports by date.
CREATE INDEX idx_res_start_time ON reservations (start_time);

-- User reservation history ("My bookings", newest first).
CREATE INDEX idx_res_user_start ON reservations (user_id, start_time DESC);

-- Active reservation lookups: the scheduler scans HELD rows by hold expiry
-- and CONFIRMED rows by start time. Partial indexes stay tiny because most
-- rows in a real system are COMPLETED/CANCELLED history.
CREATE INDEX idx_res_held_expiry      ON reservations (hold_expires_at) WHERE status = 'HELD';
CREATE INDEX idx_res_confirmed_start  ON reservations (start_time)      WHERE status = 'CONFIRMED';

-- FK columns used in joins.
CREATE INDEX idx_res_vehicle      ON reservations (vehicle_id);
CREATE INDEX idx_vehicles_user    ON vehicles (user_id);
CREATE INDEX idx_payments_res     ON payments (reservation_id);
CREATE INDEX idx_maintenance_chg  ON charger_maintenance (charger_id, reported_at DESC);

-- Waiting-list ordering: exactly the ORDER BY used by fn_process_waiting_list,
-- restricted to entries that are still waiting.
CREATE INDEX idx_wl_queue_order ON waiting_list (priority DESC, requested_at, entry_id) WHERE status = 'WAITING';
CREATE INDEX idx_wl_user        ON waiting_list (user_id, requested_at DESC);

-- Audit log lookups for one record.
CREATE INDEX idx_audit_record ON audit_logs (table_name, record_id, changed_at DESC);

ANALYZE;
