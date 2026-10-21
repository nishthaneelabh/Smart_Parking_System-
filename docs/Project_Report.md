# Smart Parking & EV Charging Reservation System
## High-Concurrency Database System for Real-Time Reservations

**DBMS Project Report**
Team: Nishtha Neelabh (25BCE5549) · Abhiudaya Shrivastava (25BCE5230)

---

## 1. Title
Smart Parking & EV Charging Reservation System: a PostgreSQL-centred
system that lets drivers reserve parking spaces and compatible EV
chargers in real time, without double bookings, even under heavy
simultaneous use.

## 2. Abstract
Parking and EV-charging reservations are a classic **high-concurrency**
problem. Many drivers search and book the same few slots at the same
moment, and a naive "check then insert" design produces double bookings,
stale availability and lost revenue.

We built a complete web application (Flask + Bootstrap) on a normalized
PostgreSQL database (13 tables, 3NF). Correctness is enforced **inside
the database**:
- **Transactions and row locks** (`SELECT … FOR UPDATE` / `NOWAIT`) make conflicting bookings take turns.
- **An exclusion constraint** on time ranges (`EXCLUDE USING gist (slot_id WITH =, booking_period WITH &&)`) makes overlapping active reservations impossible, even if the application has a bug.
- **Triggers** compute overstay fines, maintain the physical occupancy of slots and handle faulty chargers.
- **PL/pgSQL functions and procedures** implement dynamic peak-hour and AC/DC pricing, safe booking, cancellation, billing and a priority waiting list.
- **A scheduled job** (pg_cron or a Python fallback) expires unpaid holds and advances the queue.

Real concurrent tests with separate database connections show that out
of 2–6 simultaneous conflicting requests, exactly one succeeds every
time. 52 automated tests pass.

## 3. Problem statement
(PPT slide 2)
- **Double booking:** two users can reserve the same slot at the same time.
- **Wrong availability:** users see outdated slot or charger status. A slot may be free now but booked later.
- **Operational loss:** overstays, abandoned unpaid holds, faulty chargers and poor allocation reduce revenue and frustrate drivers.

The challenge is to keep availability accurate and bookings consistent
when many users act simultaneously.

## 4. Objectives
1. Design a normalized (3NF) relational schema for users, vehicles, locations, slots, chargers, reservations, waiting list, payments and pricing.
2. Guarantee **no conflicting active reservations** under concurrency, using transactions, row-level locking and database constraints.
3. Automate rules inside the database: overstay fines, slot occupancy, faulty-charger handling, hold expiry.
4. Implement dynamic pricing (peak / off-peak, AC / DC) from configurable tables.
5. Provide a fair **priority waiting list** with temporary offers.
6. Build a usable web interface for drivers and administrators.
7. Prove correctness with reproducible tests and measure index performance.

## 5. Technology stack
| Layer | Technology |
|---|---|
| Database | PostgreSQL 14+ (developed and tested on 18.6), extension `btree_gist`, optional `pg_cron` |
| Backend | Python 3.10+ (tested on 3.14), Flask 3, psycopg 3 (no ORM, so all SQL is visible) |
| Frontend | HTML5, CSS3, JavaScript (fetch API), Bootstrap 5.3, Bootstrap Icons |
| Testing | pytest, SQL scripts |
| Diagrams | Mermaid |
| Configuration | `.env` (python-dotenv) |

## 6. System architecture

```
 Browser (Bootstrap + JS)
      │  HTML pages, JSON API (/api/...), CSRF token
      ▼
 Flask app (app.py)
   routes/      auth · parking · reservations · payments · waiting_list · admin
   services/    booking_service · pricing_service · queue_service   ← transaction boundaries
   config/      database.py  (connection per request, BEGIN/COMMIT/ROLLBACK, error translation)
      │  parameterized SQL only
      ▼
 PostgreSQL  (schema "parking")
   tables + constraints (EXCLUDE, CHECK, FK)   ← integrity
   functions / procedures (PL/pgSQL)           ← business rules, locking
   triggers                                    ← automatic reactions
   pg_cron  or  scripts/scheduler.py           ← every minute: sp_run_scheduled_jobs()
```

The Python layer is deliberately thin. It validates input, decides the
transaction boundaries and turns database errors (HINT codes) into
friendly messages. Every rule that matters for correctness is in SQL, so
it holds no matter which client talks to the database.

## 7. ER diagram
See `docs/ER_Diagram.md` (Mermaid, rendered by GitHub and VS Code) and
`database/er_diagram.mmd`. Main relationships:
- USERS 1:N VEHICLES
- LOCATIONS 1:N PARKING_SLOTS
- PARKING_SLOTS 1:0..1 CHARGERS
- PARKING_SLOTS 1:N RESERVATIONS (no overlapping active ones)
- RESERVATIONS 1:N PAYMENTS
- WAITING_LIST 0..1:0..1 RESERVATIONS (offer)
- CHARGERS 1:N CHARGER_MAINTENANCE

## 8. Relational schema
See `docs/Database_Schema.md` §1 for every table and its columns.
Core:

- USERS(**user_id**, full_name, email, phone, password_hash, role, membership_tier, has_accessibility_permit, created_at)
- LOCATIONS(**location_id**, name, address, city, pincode, latitude, longitude, is_active)
- PARKING_SLOTS(**slot_id**, *location_id*, slot_code, floor_level, slot_type, size_class, occupancy_status, is_active)
- CHARGERS(**charger_id**, *slot_id*, charger_type, connector_type, power_kw, status)
- RESERVATIONS(**reservation_id**, *user_id*, *vehicle_id*, *slot_id*, start_time, end_time, booking_period, status, source, hold_expires_at, parking_fee, charging_fee, overstay_fine, total_amount, check_in_time, check_out_time, cancel_reason)
- WAITING_LIST(**entry_id**, *user_id*, *vehicle_id*, *location_id*, slot_type, charger_type, start_time, end_time, priority, status, requested_at, *offered_reservation_id*)

## 9. Normalization
All tables are in 3NF (and BCNF). Key decisions:
- Vehicles are separated from users (1NF: no repeating groups).
- Reservations do not store location or charger, which are derivable from the slot (no transitive dependency).
- Queue position is computed by a view, never stored.
- The fees stored in a reservation are the historical price agreed at booking time, not a copy of the current rate.

Details in `docs/Database_Schema.md` §3.

## 10. Table descriptions
| Table | Purpose | Key constraints |
|---|---|---|
| users | Drivers and admins | UNIQUE email and phone, CHECK formats, role/tier enums |
| vehicles | Cars, SUVs, bikes; EV connector | UNIQUE plate, EV ⇔ connector CHECK |
| locations | Parking sites | UNIQUE(name, city), pincode CHECK |
| parking_slots | Physical spaces | UNIQUE(location, code); occupancy maintained by trigger |
| chargers | One per EV slot | UNIQUE slot, AC/DC power and plug CHECK |
| charger_maintenance | Fault tickets | one open ticket per charger |
| pricing_rules | ₹/hour per location and kind | one active rule per (location, kind) |
| peak_hours | Peak windows and multipliers | start < end, 1 ≤ multiplier ≤ 5 |
| booking_policy | Hold, grace, overstay and no-show settings | single row |
| reservations | Bookings | two EXCLUDE constraints, 5 CHECKs, generated columns |
| waiting_list | Priority queue | EXCLUDE (no duplicate wait), offer consistency CHECK |
| payments | Simulated payments and refunds | amount > 0, refund consistency |
| audit_logs | Status-change history | written only by triggers |

## 11. Constraints
- **Entity integrity:** an identity primary key on every table.
- **Referential integrity:** foreign keys with deliberate CASCADE / RESTRICT / SET NULL rules (§ Database_Schema 2).
- **Domain integrity:** about 30 CHECK constraints (formats, enums, ranges, cross-column rules).
- **Uniqueness:** UNIQUE constraints and partial unique indexes.
- **Temporal integrity:** `EXCLUDE … WITH &&` on slots, vehicles and waiting-list entries.

The T20 test tries to violate each kind and confirms PostgreSQL refuses.

## 12. Sample data
`database/seed.sql` is repeatable: it truncates the tables, restarts the
identities, and computes all times relative to now. It contains:
- 14 users: 1 admin, 3 premium, 1 with an accessibility permit, 2 clean demo users.
- 15 vehicles: CCS2, Type 2, CHAdeMO and Bharat AC-001 EVs, petrol cars, an SUV and a bike.
- 6 locations in Chennai, Bengaluru and Mumbai.
- 40 slots and 16 chargers: AC 3.3–22 kW, DC 30–120 kW; 2 of the chargers are faulty.
- 19 reservations covering every status: completed (with and without overstay fines, one unpaid), cancelled, expired, no-show, 2 checked in now, 4 upcoming confirmed, a valid hold and an already-expired hold.
- 19 payments, including refunds and a failed attempt.
- 9 pricing rules and 3 peak windows.
- A **full** Chennai Central DC scenario (both chargers booked tomorrow 18:00–20:00) with 3 waiting users of different priorities.

## 13. SQL queries (examples)
```sql
-- Future availability (inside fn_search_available_slots)
SELECT s.slot_id FROM parking_slots s
WHERE s.location_id = $1 AND s.is_active
  AND NOT EXISTS (SELECT 1 FROM reservations r
                  WHERE r.slot_id = s.slot_id
                    AND r.status IN ('HELD','CONFIRMED','CHECKED_IN')
                    AND r.booking_period && tstzrange($2, $3, '[)'));

-- Queue position (view v_waiting_queue)
row_number() OVER (ORDER BY priority DESC, requested_at, entry_id)

-- Final bill (fn_final_bill)
SELECT r.total_amount,
       coalesce(sum(p.amount) FILTER (WHERE p.status = 'SUCCESS'), 0) AS amount_paid
FROM reservations r LEFT JOIN payments p USING (reservation_id)
WHERE r.reservation_id = $1 GROUP BY r.reservation_id;

-- Invariant check: must return no rows
SELECT a.reservation_id, b.reservation_id FROM reservations a JOIN reservations b
  ON a.slot_id = b.slot_id AND a.reservation_id < b.reservation_id AND a.booking_period && b.booking_period
WHERE a.status IN ('HELD','CONFIRMED','CHECKED_IN') AND b.status IN ('HELD','CONFIRMED','CHECKED_IN');
```
More in `database/demo_queries.sql`.

## 14. Transactions
Every state change runs as **one** transaction:

```python
with transaction() as cur:               # BEGIN
    cur.execute("SELECT fn_create_reservation(%s,%s,%s,%s,%s,'DIRECT',%s)", (...))
                                         # COMMIT on success, ROLLBACK on any exception
```

Examples of what one transaction covers:
- Booking: lock, overlap check, price calculation, insert.
- Payment: insert payment and set the reservation to CONFIRMED (the waiting-list entry becomes ACCEPTED via trigger).
- Cancellation: cancel, refund and process the queue.
- Admin "add EV slot": insert the slot and its charger together.
- Marking a charger faulty: ticket, status change, cancellations, refunds and requeueing.

If any step fails, nothing is left half-done.

## 15. Concurrency control
**Why a status flag is not enough.** Availability depends on the
requested time range. A slot that is free now can be booked tomorrow
evening. So we compare ranges, not flags.

**Mechanism** (`fn_create_reservation`):
1. Validate the time window and that the vehicle belongs to the user.
2. `SELECT * FROM parking_slots WHERE slot_id = $1 FOR UPDATE` (or `FOR UPDATE NOWAIT`). This serialises bookings of the **same** slot; different slots do not block each other.
3. Lock the charger `FOR SHARE`, so an admin cannot mark it faulty mid-booking. Check it is OPERATIONAL and the plug is compatible.
4. Release this slot's holds whose payment window has passed.
5. Re-check overlaps with a **fresh snapshot** (READ COMMITTED takes a new snapshot per statement) → `SLOT_UNAVAILABLE`.
6. Calculate the price in the database and insert a HELD row with a 10-minute hold.
7. Safety net: the `ex_res_no_slot_overlap` EXCLUDE constraint (SQLSTATE 23P01) is mapped to `SLOT_UNAVAILABLE` too.

**Hold vs confirmed:** HELD reserves the slot while the user pays. After
payment it is CONFIRMED. If unpaid, it becomes EXPIRED and stops blocking.

**Evidence** (separate connections, separate backend PIDs):
| Experiment | Result |
|---|---|
| A and B, same slot and time, winner holds 2 s | B waited ≈ 2,020 ms, then `SLOT_UNAVAILABLE`; 1 active row |
| NOWAIT mode | B failed in ≈ 5 ms with `SLOT_BUSY` |
| 30 rounds with no delay (CLI) | 30/30 rounds had exactly one success (A won 19, B won 11) |
| pytest: 2 users × 15 rounds, 6 users × 15 rounds | exactly one success every round |
| Different slots, same time | both succeed, in parallel |
| Two psql terminals | T2 blocked 2.0 s until T1's COMMIT, then error |

**Deadlocks:** each booking locks one slot row, then one charger row, in
a fixed order, so no cycle is possible. Queue and expiry jobs use
`SKIP LOCKED` and never wait.

## 16. Triggers
| Trigger | When | Effect |
|---|---|---|
| A — overstay fine | BEFORE UPDATE, status becomes COMPLETED | After 15-minute grace, every started late hour = parking rate × 2 (e.g. 70 min late at ₹40/h → ₹160) |
| B — slot occupancy | AFTER UPDATE, to/from CHECKED_IN | OCCUPIED at check-in, FREE at check-out. Future bookings never change it |
| C — faulty charger | AFTER UPDATE of chargers.status | FAULTY: ticket, cancel and refund upcoming bookings, requeue at priority 4. Repaired: close ticket (the procedure then serves the queue) |
| validation | BEFORE INSERT on reservations | Blocks active bookings on faulty chargers or closed slots, even raw INSERTs |
| waitlist sync | AFTER UPDATE on a WAITLIST reservation | ACCEPTED / EXPIRED / CANCELLED |
| audit | AFTER INSERT/UPDATE of status on 4 tables | Writes audit_logs |

Recursion is avoided by WHEN clauses and a one-directional chain (§ Database_Schema 6).

## 17. Stored procedures and functions
Pricing:
- `fn_get_rate`, `fn_peak_multiplier`, `fn_calculate_price` (15-minute pieces, IST clock, PARKING + AC/DC rates).

Booking life cycle:
- `fn_search_available_slots`
- `fn_create_reservation` (safe reservation)
- `fn_make_payment` (booking and fine payments; the amount always comes from the database)
- `fn_cancel_reservation` (full refund, then serve the queue)
- `fn_check_in`, `fn_check_out`, `fn_final_bill` (final billing)

Waiting list:
- `fn_user_priority`, `fn_join_waiting_list`, `fn_process_waiting_list` (allocation)

Automation:
- `fn_run_expiry_jobs`; procedures `sp_run_scheduled_jobs`, `sp_mark_charger_faulty`, `sp_mark_charger_repaired`.

All rates and time limits are read from `pricing_rules`, `peak_hours`
and `booking_policy`. Parameters, return values and error codes are
listed in `docs/Database_Schema.md` §5.

## 18. Waiting-list algorithm
1. **Join** (`fn_join_waiting_list`): allowed only when **no** compatible slot is free for the requested location, slot type, charger type and time. Priority comes from the profile: 3 accessibility permit, 2 premium, 1 standard (4 is reserved for drivers displaced by a charger fault). A vehicle cannot wait twice for overlapping times.
2. **Order:** `priority DESC, requested_at ASC, entry_id ASC` (deterministic).
3. **Trigger points:** cancellation, early check-out, hold expiry, charger repair, scheduler run, a new user joining.
4. **Allocate** (`fn_process_waiting_list`):
   ```
   FOR each WAITING entry in queue order  (FOR UPDATE SKIP LOCKED):
       FOR each compatible slot with no overlapping active booking  (FOR UPDATE OF slot SKIP LOCKED):
           try fn_create_reservation(..., source => 'WAITLIST')   -- re-checks everything
           on success: entry := OFFERED; next entry
   ```
   An entry that cannot be matched is skipped. It does not block lower-priority users who want a different place or time.
5. **Offer, not auto-confirm:** the user receives a HELD reservation valid for 10 minutes (`waitlist_offer_minutes`). Paying makes it CONFIRMED and the entry ACCEPTED. Not paying makes it EXPIRED, the entry EXPIRED, and the queue advances to the next user. Declining makes it CANCELLED, and the queue advances.
6. **Safety:** SKIP LOCKED on both the entries and the slots, plus the EXCLUDE constraint. Two workers running at once made exactly one offer for one freed slot (test T17b).

## 19. Indexing and query optimization
Indexes cover location lookups, slot search, charger status, reservation
timestamps, user history, active-reservation lookups (partial indexes on
HELD and CONFIRMED) and queue order. Foreign keys are indexed too. The
exclusion constraints provide GiST range indexes.

Measured with `database/benchmark.sql` (202,051 reservations, rolled back afterwards, PostgreSQL 18.6):

| Query | With index | Without |
|---|---|---|
| User history (last 20) | 0.34 ms | 7.30 ms |
| Expired holds (scheduler) | 0.009 ms | 16.1 ms (parallel seq scan) |
| Slot free in range? | 0.19 ms | 17.3 ms (parallel seq scan) |

With the 19 seed rows PostgreSQL rightly uses sequential scans. Index
benefits only appear on realistic volumes. One honest finding: when
bookings were spread evenly across users, dropping the user-history
index made no difference, because another index served the query just
as well. Indexes only pay off for selective conditions.

## 20. Testing
52 pytest tests cover T01–T20 and more: registration, login and RBAC,
search, booking, real concurrency (2 and 6 users, NOWAIT, different
slots), overlap / non-overlap, cancellation, hold expiry, no-show, slot
release, peak and charger pricing, overstay fines (6 boundary cases),
waiting-list insertion, ordering and progression (including two parallel
workers), faulty charger and repair, and integrity violations.

Result on 21 Oct 2026: **52 passed**. Details in `docs/Test_Cases.md`.

## 21. Results and limitations
**Results**
- Under every concurrent scenario tested, no double booking occurred, and the database rejects overlapping active reservations even when application code is bypassed.
- Fines, occupancy, charger faults, expiry and waiting-list offers all happen automatically.
- The web interface covers the full driver and admin workflow.

**Limitations**
- Payments are simulated; there is no real gateway.
- Check-in and check-out are buttons; in reality, gate sensors or ANPR cameras would call the same functions.
- No real notifications (SMS or email): offers appear on the dashboard and waiting-list page.
- Overstay blocking: if a driver overstays into the next booking, the next driver's check-in is refused (`SLOT_OCCUPIED`). Automatic relocation to another slot is not implemented.
- The concurrency tests run on one machine; we did not load-test hundreds of users over a network.
- `pg_cron` requires server configuration, so on most student laptops the Python scheduler is used instead (same stored procedure).

## 22. Conclusion
By putting the critical rules into PostgreSQL itself (transactions, row
locks, an exclusion constraint on time ranges, triggers and stored
functions), the system stays correct regardless of how many users act at
once or how the application is written. The project demonstrates the
core DBMS ideas from the PPT: reliable, fast, consistent and scalable
reservation handling.

## 23. Future enhancements
- A real payment gateway (Razorpay/UPI) with webhooks that call `fn_make_payment`.
- Sensor/ANPR integration for automatic check-in and check-out.
- SMS, email or push notifications for waiting-list offers (e.g. `LISTEN/NOTIFY`).
- Energy-based billing (₹/kWh) using charger meter readings.
- Automatic relocation of bookings to an equivalent slot when a charger fails.
- Read replicas and table partitioning of `reservations` by month for very large histories.
- A map view of locations, and a mobile app using the same JSON API.
