# Database Schema

All objects live in the PostgreSQL schema `parking`. `schema.sql` sets
`search_path` for the database, so in `psql` you can simply type `\dt`.

Script order (`database/setup.sql` runs them all):

| # | File | Contents |
|---|---|---|
| 1 | `schema.sql` | Drops and recreates the schema: 13 tables, keys and constraints |
| 2 | `functions.sql` | Pricing, search, safe booking, payment, cancel, check-in/out, waiting list, expiry jobs, views |
| 3 | `procedures.sql` | `sp_run_scheduled_jobs`, `sp_mark_charger_faulty`, `sp_mark_charger_repaired` |
| 4 | `triggers.sql` | Triggers A, B, C plus validation, waiting-list sync and audit |
| 5 | `indexes.sql` | Performance indexes and two integrity-related unique indexes |
| 6 | `seed.sql` | Repeatable sample data |
| 7 | `scheduler.sql` | Registers a pg_cron job if pg_cron is available |
| – | `concurrency_demo.sql` | Two-terminal double-booking demonstration |
| – | `demo_queries.sql` | Verification commands for the examiner |
| – | `benchmark.sql` | Optional 200k-row index benchmark (rolled back afterwards) |

---

## 1. Relational schema

Notation: **bold** = primary key, *italic* = foreign key, (U) = unique.

- **USERS**(**user_id**, full_name, email (U), phone (U), password_hash, role, membership_tier, has_accessibility_permit, created_at)
- **VEHICLES**(**vehicle_id**, *user_id*, registration_no (U), vehicle_type, model_name, is_ev, connector_type, created_at)
- **LOCATIONS**(**location_id**, name, address, city, pincode, latitude, longitude, is_active, created_at) — (name, city) U
- **PARKING_SLOTS**(**slot_id**, *location_id*, slot_code, floor_level, slot_type, size_class, occupancy_status, is_active, created_at) — (location_id, slot_code) U
- **CHARGERS**(**charger_id**, *slot_id* (U), charger_type, connector_type, power_kw, status, installed_on)
- **CHARGER_MAINTENANCE**(**maintenance_id**, *charger_id*, issue_description, *reported_by*, reported_at, resolved_at, resolution_note)
- **PRICING_RULES**(**rule_id**, *location_id*, applies_to, rate_per_hour, is_active, description)
- **PEAK_HOURS**(**peak_id**, label, day_type, start_time, end_time, multiplier)
- **BOOKING_POLICY**(**policy_id** = 1, hold_minutes, waitlist_offer_minutes, grace_minutes, overstay_multiplier, no_show_minutes, early_checkin_minutes, min_booking_minutes, max_booking_hours, max_advance_days, pricing_timezone)
- **RESERVATIONS**(**reservation_id**, *user_id*, *vehicle_id*, *slot_id*, start_time, end_time, booking_period†, status, source, hold_expires_at, parking_fee, charging_fee, overstay_fine, total_amount†, check_in_time, check_out_time, cancel_reason, created_at, updated_at)
- **WAITING_LIST**(**entry_id**, *user_id*, *vehicle_id*, *location_id*, slot_type, charger_type, start_time, end_time, requested_period†, priority, status, requested_at, *offered_reservation_id* (U), offered_at, updated_at)
- **PAYMENTS**(**payment_id**, *reservation_id*, amount, payment_type, method, status, transaction_ref (U), paid_at, refunded_at)
- **AUDIT_LOGS**(**log_id**, table_name, record_id, action, old_status, new_status, details, changed_at)

† = `GENERATED ALWAYS AS (...) STORED` columns. PostgreSQL computes them,
so they can never disagree with the columns they are built from.

Primary keys use `GENERATED ALWAYS AS IDENTITY`, the SQL-standard
replacement for `SERIAL`.

---

## 2. Table descriptions and constraints

### USERS
| Column | Type | Rules |
|---|---|---|
| user_id | INTEGER identity | PK |
| email | VARCHAR(150) | NOT NULL, UNIQUE, CHECK valid format, CHECK lower-case |
| phone | VARCHAR(15) | NOT NULL, UNIQUE, CHECK `^[6-9][0-9]{9}$` (Indian mobile) |
| password_hash | TEXT | Werkzeug scrypt hash; plain passwords are never stored |
| role | VARCHAR(10) | DEFAULT 'USER', CHECK IN ('USER','ADMIN') |
| membership_tier | VARCHAR(10) | DEFAULT 'STANDARD', CHECK IN ('STANDARD','PREMIUM') |
| has_accessibility_permit | BOOLEAN | DEFAULT FALSE |

### VEHICLES
- `user_id` FK → users `ON DELETE CASCADE`: deleting a user removes their cars. This is still blocked if the car has reservations (see below).
- `registration_no` UNIQUE, CHECK Indian plate format (`TN09AB1234`).
- `ck_vehicles_ev_connector`: an EV **must** have a connector; a non-EV **must not**.

### LOCATIONS
- UNIQUE(name, city); `pincode` CHECK 6 digits, not starting with 0; latitude and longitude range CHECKs.
- `is_active = FALSE` closes the location for new bookings.

### PARKING_SLOTS
- `location_id` FK `ON DELETE RESTRICT`: a location with slots cannot be deleted.
- UNIQUE(location_id, slot_code): "E01" can exist at every location, but only once at each.
- `slot_type` REGULAR / EV, `size_class` BIKE / CAR / SUV. A vehicle fits when its size ≤ the slot size.
- `occupancy_status` FREE / OCCUPIED: **physical state right now**, changed only by trigger B.

### CHARGERS
- `slot_id` FK + UNIQUE: at most one charger per slot.
- `ck_chargers_type_power`: AC ≤ 22 kW with TYPE2 / BHARAT_AC001; DC ≥ 15 kW with CCS2 / CHADEMO.
- `status` OPERATIONAL / FAULTY.
- Trigger `trg_charger_slot_is_ev`: a charger can only be attached to an EV slot.

### RESERVATIONS — the central table
| Constraint | Purpose |
|---|---|
| `ck_res_time_order` | end_time > start_time |
| `ck_res_hold_needed` | a HELD row must have `hold_expires_at` |
| `ck_res_checkin_time` | CHECKED_IN / COMPLETED rows must have `check_in_time` |
| `ck_res_checkout_time` | `check_out_time` is set **if and only if** status = COMPLETED |
| `ck_res_checkout_after_checkin` | check-out ≥ check-in |
| **`ex_res_no_slot_overlap`** | `EXCLUDE USING gist (slot_id WITH =, booking_period WITH &&) WHERE (status IN ('HELD','CONFIRMED','CHECKED_IN'))` — **no two active reservations of the same slot may overlap in time** |
| `ex_res_no_vehicle_overlap` | the same for `vehicle_id`: one car cannot be in two places at once |
| FKs | user, vehicle and slot, all `ON DELETE RESTRICT` (history is preserved) |

`booking_period` is `tstzrange(start_time, end_time, '[)')`. It includes
the start and excludes the end, so a booking ending at 10:00 does **not**
clash with one starting at 10:00.

`total_amount = parking_fee + charging_fee + overstay_fine` is a generated column.

### WAITING_LIST
- `priority` CHECK 1..4, `status` CHECK of five values.
- `ck_wl_charger_only_for_ev`: a charger type may only be requested for EV slots.
- `ck_wl_offer_has_res`: OFFERED or ACCEPTED entries must point to a reservation.
- `ex_wl_no_duplicate_wait`: a vehicle cannot wait twice for overlapping times.

### PAYMENTS
- `amount > 0`; `payment_type` BOOKING / FINE; `method` UPI / CARD / NETBANKING / WALLET.
- `status` SUCCESS / FAILED / REFUNDED; `refunded_at` is set if and only if REFUNDED.
- `transaction_ref` UNIQUE.

### PRICING_RULES, PEAK_HOURS, BOOKING_POLICY
- One **active** rule per (location, applies_to): unique index on `(coalesce(location_id,0), applies_to) WHERE is_active`.
- `peak_hours`: start < end, multiplier between 1 and 5.
- `booking_policy`: `CHECK (policy_id = 1)` makes it a single-row table.

### CHARGER_MAINTENANCE and AUDIT_LOGS
- At most one **open** ticket per charger (`uq_maintenance_open_ticket ... WHERE resolved_at IS NULL`).
- AUDIT_LOGS is written only by triggers.

---

## 3. Normalization

**1NF — atomic values, no repeating groups.** Every column holds one
value. Vehicles are a separate table instead of `vehicle1, vehicle2`
columns. The time range is a single `tstzrange` value; it is a generated
column, so it adds no redundancy.

**2NF — no partial dependency on part of a key.** Every table has a
single-column surrogate primary key, so partial dependencies cannot occur.
Natural composite keys such as (location_id, slot_code) are declared
UNIQUE. The only other column that depends on them is the slot itself.

**3NF — no transitive dependency (non-key → non-key).**
- RESERVATIONS stores `slot_id` but **not** `location_id` or `charger_id`. Both follow from the slot (`slot → location`, `slot → charger`), so storing them would be transitive.
- RESERVATIONS does not store the user's name or the vehicle's plate. They come from joins (`v_reservation_details`).
- Prices: rates live once in PRICING_RULES. RESERVATIONS stores the **amount charged at booking time** (`parking_fee`, `charging_fee`). That is a historical fact of the booking, not a copy of the rate. Changing a rate later must not change what an old booking cost.
- WAITING_LIST.priority is stored, although it is usually derived from the user's profile. It is a snapshot taken when the user joined; priority 4 (service recovery) cannot be derived from the profile at all. Queue position, by contrast, is **never** stored: it is computed with `row_number()` in `v_waiting_queue`, so it can never go out of date.
- The one deliberately stored "derived" state is `parking_slots.occupancy_status`. It is physical reality (a sensor or gate would set it), and it is maintained only by trigger B, so it stays consistent with check-in and check-out.

Every table is therefore in 3NF. Each determinant in each table is a
candidate key, so the tables are in fact also in BCNF.

---

## 4. Availability concepts (important for the viva)

| Concept | Where it lives | Example |
|---|---|---|
| **Current physical occupancy** | `parking_slots.occupancy_status` | A car is standing in A01 right now → OCCUPIED |
| **Future reservation availability** | Computed: no ACTIVE reservation whose `booking_period` overlaps the requested range (`fn_search_available_slots`) | A01 is FREE now, but booked tomorrow 18:00–20:00 → not available for 19:00–21:00 tomorrow, available for 10:00–12:00 |
| **Temporary hold** | `status = 'HELD'`, `hold_expires_at = now() + 10 min` | Slot is reserved while the user pays; blocks other bookings |
| **Confirmed reservation** | `status = 'CONFIRMED'` after payment | Guaranteed; becomes CHECKED_IN on arrival |
| **Expired reservation** | `EXPIRED` (hold not paid in time) or `NO_SHOW` (paid but did not arrive within 30 min) | No longer blocks the slot |

A slot is **never** marked unavailable just because it has a future
booking. That is why the availability check cannot rely on a status
column: it must compare time ranges.

Reservation life cycle:

```
HELD ──pay──▶ CONFIRMED ──check-in──▶ CHECKED_IN ──check-out──▶ COMPLETED
 │               ├──cancel──▶ CANCELLED
 │               └──no arrival──▶ NO_SHOW
 ├──hold timer──▶ EXPIRED
 └──cancel──▶ CANCELLED
```

---

## 5. Functions and procedures (reference)

All business errors are raised as `ERRCODE 'P0001'` with a readable
message and a machine code in `HINT`.

| Name | Parameters | Returns | Errors (HINT) |
|---|---|---|---|
| `fn_get_rate` | location_id, applies_to | ₹/hour | NO_PRICING_RULE |
| `fn_peak_multiplier` | timestamptz | multiplier (1.00 off-peak) | — |
| `fn_calculate_price` | location, slot_type, charger_type, start, end | parking_fee, charging_fee, total, peak_minutes, offpeak_minutes | INVALID_TIME, INVALID_CHARGER |
| `fn_search_available_slots` | start, end, [location, city, slot_type, charger_type, vehicle] | slot rows + price estimate | INVALID_TIME |
| **`fn_create_reservation`** | user, vehicle, slot, start, end, source='DIRECT', nowait=false | reservation_id (HELD) | INVALID_TIME, VEHICLE_NOT_OWNED, SLOT_NOT_FOUND, SLOT_INACTIVE, VEHICLE_INCOMPATIBLE, CHARGER_FAULTY, **SLOT_UNAVAILABLE**, VEHICLE_ALREADY_BOOKED, SLOT_BUSY |
| `fn_make_payment` | reservation, user, method, is_admin, simulate_failure | payment_id | RESERVATION_NOT_FOUND, HOLD_EXPIRED, NOTHING_TO_PAY, INVALID_STATE, INVALID_METHOD |
| `fn_cancel_reservation` | reservation, user, is_admin, reason | refunded amount | RESERVATION_NOT_FOUND, CANNOT_CANCEL |
| `fn_check_in` | reservation, user, is_admin | check-in time | INVALID_STATE, TOO_EARLY, TOO_LATE, SLOT_OCCUPIED |
| `fn_check_out` | reservation, user, is_admin, checkout_time (admin only) | final bill row | INVALID_STATE, INVALID_TIME |
| `fn_final_bill` | reservation | fees, fine, paid, refunded, balance, overstay minutes | — |
| `fn_user_priority` | user | 1, 2 or 3 | — |
| `fn_join_waiting_list` | user, vehicle, location, slot_type, charger_type, start, end | entry_id | SLOTS_AVAILABLE, ALREADY_WAITING, VEHICLE_INCOMPATIBLE, … |
| `fn_process_waiting_list` | max_offers=100 | number of offers made | — |
| `fn_run_expiry_jobs` | — | expired_holds, no_shows, expired_waits, offers_made | — |
| `sp_run_scheduled_jobs` (PROCEDURE) | — | prints a NOTICE | — |
| `sp_mark_charger_faulty` (PROCEDURE) | charger, issue, admin | — | CHARGER_NOT_FOUND, ALREADY_FAULTY |
| `sp_mark_charger_repaired` (PROCEDURE) | charger, note | — | CHARGER_NOT_FOUND, NOT_FAULTY |

Views: `v_reservation_details`, `v_waiting_queue` (with computed
`queue_position`), `v_slot_overview`.

---

## 6. Triggers

| Trigger | Table / timing | Fires when | Does |
|---|---|---|---|
| **A** `trg_res_a_overstay_fine` | reservations, BEFORE UPDATE OF status | status becomes COMPLETED | Sets `overstay_fine`: if check-out > end + 15 min grace, every started hour after end × parking rate × 2 |
| **B** `trg_res_slot_occupancy` | reservations, AFTER UPDATE OF status | status changes to or from CHECKED_IN | Slot OCCUPIED on check-in, FREE on check-out |
| **C** `trg_charger_status_change` | chargers, AFTER UPDATE OF status | status changes | FAULTY: open ticket, cancel and refund upcoming HELD/CONFIRMED bookings on that slot, put future ones on the waiting list with priority 4. Repaired: close tickets |
| `trg_res_validate_insert` | reservations, BEFORE INSERT | every insert | Vehicle must belong to user; active bookings refused on inactive slots or faulty chargers, even for raw INSERTs |
| `trg_res_waitlist_sync` | reservations, AFTER UPDATE OF status | a WAITLIST offer leaves HELD | Entry → ACCEPTED / EXPIRED / CANCELLED |
| `trg_charger_slot_is_ev`, `trg_slot_type_guard` | chargers / parking_slots | insert / type change | Chargers only on EV slots |
| `trg_res_updated_at`, `trg_wl_updated_at` | BEFORE UPDATE | every update | `updated_at = now()` |
| `trg_audit_*` | 4 tables, AFTER INSERT/UPDATE OF status | status changes | Row in AUDIT_LOGS |

**No recursion.** No trigger writes back to the table that fired it,
except BEFORE triggers that only modify `NEW`. The chain of effects is
`chargers → reservations → parking_slots / waiting_list`, and none of
those triggers writes back to `chargers`. Every trigger also has a
`WHEN` clause, so it runs only when the status really changes.

**Faulty-charger policy (documented choice).** Upcoming bookings are
cancelled with a 100% refund, not silently moved, because the user chose
a specific charger. Drivers whose booking was still in the future go to
the front of the waiting list (priority 4). If another compatible charger
is free, or once this one is repaired, they get an offer first. Sessions
already CHECKED_IN are left alone, since the car is physically there and
staff handle it.

---

## 7. Indexing and EXPLAIN ANALYZE

| Index | Columns | Supports |
|---|---|---|
| GiST of `ex_res_no_slot_overlap` | (slot_id, booking_period) WHERE active | "Is slot X free between A and B?" (booking, search) |
| GiST of `ex_res_no_vehicle_overlap` | (vehicle_id, booking_period) WHERE active | Vehicle double-booking check |
| `idx_res_user_start` | (user_id, start_time DESC) | My Bookings / user history |
| `idx_res_start_time` | (start_time) | Admin reservation list, reports by date |
| `idx_res_held_expiry` | (hold_expires_at) WHERE status='HELD' | Scheduler: expired holds |
| `idx_res_confirmed_start` | (start_time) WHERE status='CONFIRMED' | Scheduler: no-shows |
| `idx_slots_location_type` | (location_id, slot_type) WHERE is_active | Slot search by location |
| `idx_locations_city` | lower(city) WHERE is_active | Location browse by city |
| `idx_chargers_status`, `idx_chargers_type` | status / (charger_type, connector_type) | Faulty-charger list, charger filters |
| `idx_wl_queue_order` | (priority DESC, requested_at, entry_id) WHERE WAITING | Exactly the queue ORDER BY |
| `idx_res_vehicle`, `idx_vehicles_user`, `idx_payments_res`, `idx_maintenance_chg` | FK columns | Joins (PostgreSQL does not index FKs automatically) |

### Measurements

With the 19 seed reservations, PostgreSQL correctly prefers sequential
scans: reading one 8 KB page is cheaper than using an index. Indexes
cannot be judged on that data. `database/benchmark.sql` therefore adds
about 200,000 historical and 2,000 upcoming reservations **inside a
transaction that is rolled back**, then runs each query with and without
its index.

Measured on the development machine (PostgreSQL 18.6, Linux, warm cache,
202,051 reservations). **Run it yourself and quote your own numbers.**

| Query | With index | Plan | Without index | Plan |
|---|---|---|---|---|
| Q1 last 20 bookings of a light user | 0.34 ms | Index Scan `idx_res_user_start` | 7.30 ms | Backward scan of `idx_res_start_time`, filtering out 19,032 rows |
| Q2 expired HELD rows (scheduler) | 0.009 ms | Index Scan `idx_res_held_expiry` | 16.1 ms | Parallel Seq Scan |
| Q3 is slot 8 free on a given range? | 0.19 ms | GiST index scan | 17.3 ms | Parallel Seq Scan |

Things we observed and you should mention honestly:

- For Q3 the planner chose the **vehicle** exclusion GiST index (filtering on `slot_id`) rather than the slot one. Both index `booking_period`, so dropping only one of them makes no difference. The benchmark drops both.
- On the first version of the benchmark, user bookings were spread evenly over all users. Dropping `idx_res_user_start` then made **no** difference, because the planner simply used `idx_res_start_time`. An index only pays off when the condition is selective.
- All numbers are milliseconds on a laptop. The point is the change of plan (index scan vs sequential scan), which grows with table size.
