# Viva Questions and Answers

Each answer is written so you can say it in your own words. File names
show where to point if the examiner asks "show me".

---

### Transactions and ACID

**1. What is a transaction?**
A group of SQL statements that must succeed or fail **as one unit**. In our
booking: lock the slot, check overlaps, insert the reservation. Either all
three happen (COMMIT) or none (ROLLBACK). See `services/booking_service.py`
`create_reservation()`: `with transaction()` sends BEGIN, then COMMIT or
ROLLBACK.

**2. Explain ACID with our project.**
- **Atomicity:** if the INSERT fails, the earlier steps are undone too. Cancelling a booking and refunding its payment happen together in `fn_cancel_reservation`.
- **Consistency:** constraints (FK, CHECK, EXCLUDE) mean the database can never contain, say, a reservation whose end is before its start, or two overlapping active bookings.
- **Isolation:** two users booking at the same moment do not see each other's half-finished work. Row locks make them take turns on the same slot.
- **Durability:** after COMMIT, PostgreSQL has written the change to its write-ahead log (WAL), so a power cut cannot lose a confirmed booking.

**3. What is the difference between COMMIT and ROLLBACK?**
COMMIT makes all changes of the transaction permanent and visible to
others. ROLLBACK throws them all away. In psycopg, leaving the
`with conn.transaction():` block normally commits; an exception rolls back.

### Concurrency, race conditions and double booking

**4. What is a race condition? Give the double-booking example.**
The result depends on the timing of two users. User A reads "slot free",
user B reads "slot free", A inserts, B inserts: **two bookings for one
slot**. Both "check, then insert" steps interleaved. This is shown on
slide 6 of our PPT.

**5. How does your system prevent double booking?**
Two layers:
1. `SELECT … FROM parking_slots WHERE slot_id = $1 FOR UPDATE` inside `fn_create_reservation`. The second transaction **waits** for the first one's lock. When it continues, it re-checks overlaps, sees the first booking and raises `SLOT_UNAVAILABLE`.
2. The constraint `EXCLUDE USING gist (slot_id WITH =, booking_period WITH &&) WHERE (status IN ('HELD','CONFIRMED','CHECKED_IN'))`. Even a raw INSERT that bypasses our function cannot create an overlapping active booking. PostgreSQL itself rejects it.

**6. Why not just check `parking_slots.status = 'AVAILABLE'`?**
A slot can be free **now** but booked tomorrow 6–8 PM, and free again
after 8 PM. Availability depends on the **time range** asked for, so we
compare ranges with `&&` (overlaps). `occupancy_status` only describes
the physical state right now.

**7. What does SELECT … FOR UPDATE do?**
It reads rows and puts a **row-level exclusive lock** on them until the
transaction ends. Others can still *read* the row with a normal SELECT,
but anyone trying to lock or update it waits.

**8. What is NOWAIT? When would you use it?**
`FOR UPDATE NOWAIT` does not wait. If the row is locked, it errors
immediately (`55P03 lock_not_available`), which we show as `SLOT_BUSY`.
It is useful when you prefer a quick "try again" over making the user
wait. Our website uses the waiting version, so the second user gets the
precise answer "Slot Unavailable". The demo page has a NOWAIT switch.

**9. Why does the second user see the first booking after waiting? Isn't the snapshot old?**
We use the default **READ COMMITTED** isolation level. In PL/pgSQL, every
statement takes a **new snapshot**. When B's `FOR UPDATE` finally gets
the lock, B's next statement (the overlap check) sees A's committed row.

**10. What is a deadlock? Can it happen here?**
Two transactions each hold a lock the other needs, so both wait forever.
PostgreSQL detects this after about 1 s and aborts one of them
(`40P01`). Our booking locks only **one** slot row, then one charger row
in a fixed order (slot → charger), so a cycle cannot form between
bookings. The waiting-list worker uses `SKIP LOCKED`, so it never waits
on a locked slot at all.

**11. What is SKIP LOCKED and where do you use it?**
It skips rows that another transaction has locked instead of waiting. The
waiting-list processor and the expiry job use it. Two queue workers
running at the same time therefore pick **different** entries and slots,
and never offer one slot to two people (test T17b).

**12. Name the isolation levels. Which one do you use and why?**
- READ UNCOMMITTED (behaves like READ COMMITTED in PostgreSQL)
- **READ COMMITTED** (default, ours)
- REPEATABLE READ
- SERIALIZABLE

We use READ COMMITTED plus explicit row locks and an exclusion
constraint. SERIALIZABLE would also prevent the anomaly, but conflicting
transactions then fail with `40001 serialization_failure` and must be
retried in application code. Explicit locks are easier to explain and
give a clear "Slot Unavailable" message.

**13. How did you *prove* concurrency works?**
We use real separate connections, i.e. separate PostgreSQL backend
processes with different PIDs:
- `tests/test_concurrency.py`: 2 and 6 users race for 15 rounds each; there is always exactly 1 winner.
- `scripts/concurrency_demo.py --race 30`.
- The admin "Concurrency demo" page.
- Two psql terminals following `database/concurrency_demo.sql`.

After each run the check query shows exactly 1 active overlapping row.

### Keys, constraints, normalization

**14. Primary key vs foreign key vs unique key?**
- **PK:** uniquely identifies a row; NOT NULL; one per table (`reservation_id`).
- **FK:** a column whose value must exist as a PK in another table (`reservations.slot_id → parking_slots.slot_id`).
- **UNIQUE:** no duplicates, but it is not the row's identity (email, phone, registration_no).

**15. Explain the ON DELETE rules you chose.**
- `CASCADE`: deleting a user deletes their vehicles and waiting-list entries.
- `RESTRICT`: a location with slots, or a vehicle or slot with reservations, cannot be deleted. Booking history must be kept.
- `SET NULL`: if a user who reported a fault is deleted, the ticket stays and `reported_by` becomes NULL.

**16. What CHECK constraints do you have? Give three.**
- Phone must match `^[6-9][0-9]{9}$`.
- An EV must have a connector and a non-EV must not.
- An AC charger must be ≤ 22 kW with a Type 2 or Bharat plug.
- `end_time > start_time`.
- `booking_policy.policy_id = 1` (single-row table).

**17. What is an exclusion constraint?**
A generalisation of UNIQUE. Instead of "no two rows are equal", it says
"no two rows satisfy these operators". Ours: same `slot_id` (`=`) **and**
overlapping `booking_period` (`&&`). It needs a GiST index;
`btree_gist` lets GiST handle the integer `=` part.

**18. What is 3NF? Is your schema in 3NF?**
A table is in 3NF when it is in 2NF and no non-key column depends on
another non-key column (no transitive dependency). Example: RESERVATIONS
has `slot_id` but not `location_id` or `charger_id`, because those follow
from the slot. Storing them would be `reservation → slot → location`.
Every table is in 3NF (in fact BCNF). See `docs/Database_Schema.md` §3.

**19. You store parking_fee in RESERVATIONS. Isn't that redundant with PRICING_RULES?**
No. The rate is a property of the rule today. The fee is a fact about
**that booking**: the price agreed at booking time. If the admin changes
the rate tomorrow, yesterday's booking must still cost what the customer
paid. `total_amount` is a generated column, so it cannot be inconsistent
either.

### Triggers, functions, procedures

**20. What is a trigger? Explain your three main ones.**
Code that PostgreSQL runs automatically when a table changes.
- **A** (BEFORE UPDATE on reservations, when status becomes COMPLETED): calculates the overstay fine.
- **B** (AFTER UPDATE): check-in sets the slot OCCUPIED; check-out sets it FREE.
- **C** (AFTER UPDATE on chargers): when a charger turns FAULTY, cancels and refunds upcoming bookings, opens a ticket and queues the drivers with priority 4. On repair, closes the ticket.

**21. BEFORE vs AFTER trigger?**
- BEFORE runs before the row is written and can **change NEW**. Trigger A sets `NEW.overstay_fine` before the row is saved.
- AFTER runs once the row is written. It is used for side effects on **other** tables (trigger B updates `parking_slots`).

**22. How did you avoid recursive triggers?**
No trigger updates the table that fired it (except BEFORE triggers
editing NEW). Every trigger has a `WHEN (OLD.status IS DISTINCT FROM
NEW.status …)` condition. The chain chargers → reservations → slots /
waiting list never comes back to chargers.

**23. Function vs procedure in PostgreSQL?**
- A **function** is called inside SQL (`SELECT fn_calculate_price(...)`), returns a value or table, and runs inside the caller's transaction.
- A **procedure** is called with `CALL`, returns nothing (only INOUT parameters), and may COMMIT inside itself.

Our procedures are `sp_run_scheduled_jobs` (called by pg_cron),
`sp_mark_charger_faulty` and `sp_mark_charger_repaired`.

**24. How is the price calculated?**
`fn_calculate_price` splits the booking into 15-minute pieces. For each
piece: `rate × minutes/60 × peak multiplier at that time`, with the clock
time read in Asia/Kolkata. Parking uses the PARKING rate; EV slots add
the AC or DC rate. Rates and peak windows come from tables, never from
the browser. Example: Wed 17:00–19:00, ₹40/h, ×1.5 → ₹120.

**25. How does the waiting list work?**
- **Order:** `ORDER BY priority DESC, requested_at, entry_id`. Priorities: 4 service recovery, 3 accessibility, 2 premium, 1 standard.
- **Allocation:** when capacity frees up (cancellation, early check-out, expiry, charger repair), `fn_process_waiting_list` finds a compatible free slot for the highest entry and creates a **temporary offer**: a HELD reservation valid for 10 minutes.
- **Outcome:** if the user pays, the entry becomes ACCEPTED. If not, the hold expires, the entry becomes EXPIRED, and the next user gets an offer.

**26. How do holds expire without someone clicking a button?**
`fn_run_expiry_jobs()` expires holds, marks no-shows and processes the
queue. It is run every minute by pg_cron (`scheduler.sql`) or by
`scripts/scheduler.py`. It is **idempotent**: it only touches rows still
in the "due" state and uses SKIP LOCKED, so running it twice or in
parallel is harmless. The booking function also releases stale holds on
the slot it locks.

### Indexing and EXPLAIN

**27. What is an index? Which ones did you create and why?**
A separate sorted structure (B-tree, or GiST for ranges) that lets
PostgreSQL find rows without reading the whole table. Examples:
- `idx_res_user_start (user_id, start_time DESC)` for "My bookings".
- Partial `idx_res_held_expiry … WHERE status='HELD'` for the scheduler.
- `idx_wl_queue_order` matching the queue's ORDER BY.
- The GiST index of the exclusion constraint for overlap checks.

PostgreSQL does not index foreign keys automatically, so we added those
too.

**28. What does EXPLAIN ANALYZE show?**
EXPLAIN shows the **plan** (Seq Scan, Index Scan, joins) with estimated
costs. ANALYZE actually **runs** the query and adds real times and row
counts. On our 202k-row benchmark, the "is slot free?" check took
**0.19 ms** with the GiST index versus **17.3 ms** with a parallel
sequential scan.

**29. With your seed data EXPLAIN shows Seq Scan. Is the index useless?**
No. The table has about 20 rows (one disk page). Reading it is cheaper
than walking an index, so the planner correctly chooses a Seq Scan.
That is why `benchmark.sql` loads 200k rows inside a rolled-back
transaction to measure fairly.

**30. What is a partial index?**
An index with a WHERE clause, e.g. `WHERE status = 'HELD'`. It contains
only the few rows the query cares about, so it is small and fast, while
most rows (completed history) are not indexed at all.

### Design questions

**31. Why PostgreSQL rather than MySQL?**
We needed exclusion constraints, range types (`tstzrange`), GiST, PL/pgSQL
procedures, `SKIP LOCKED` and pg_cron. MySQL has no exclusion constraints
or range types.

**32. How do you stop SQL injection? How do you stop a user changing the price?**
- **SQL injection:** every query uses `%s` placeholders, so psycopg sends values separately from the SQL text.
- **Price:** the booking API accepts only slot, vehicle and time. The database calculates the price; any price field in the request is ignored (test T04).

**33. How do you stop normal users from using admin pages?**
`@admin_required` checks `session['role'] == 'ADMIN'` **on the server**
for every admin route and returns 403 otherwise (test T02). Hiding the
menu link alone would not be security.
