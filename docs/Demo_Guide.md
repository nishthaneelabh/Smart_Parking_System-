# Demo Guide (5–10 minutes)

## Before the examiner arrives (5 minutes)

1. Start PostgreSQL. Reset the data so every demo starts from the same state:
   ```
   python scripts/init_db.py --seed-only
   ```
2. Terminal 1: `python app.py`, then open <http://127.0.0.1:5000>.
3. Terminal 2: `python scripts/scheduler.py`. Leave it visible; it prints a line every minute.
4. Terminal 3: `psql -U postgres -d smart_parking`.
5. Open `docs/ER_Diagram.md` in VS Code preview, or the PNG you exported from mermaid.live.
6. Open two browser windows side by side (one normal, one private), both on the login page.

Sample data seeds times **relative to now**, so "tomorrow 18:00" and
"checked in now" are always correct on demo day.

---

## The script

### 1. Database tables (≈ 45 s) — Terminal 3
```sql
\dt
\d reservations
```
Point at the `ex_res_no_slot_overlap` EXCLUDE constraint and the CHECK
constraints. Say: *"These rules are inside the database, not just in our
Python code."*

### 2. ER diagram (≈ 30 s)
Show the 6 core entities from the PPT plus the supporting tables. Explain:
- why vehicles are a separate table (one user, many vehicles);
- why reservations do not store `location_id` (3NF).

### 3. Sample data (≈ 30 s)
```sql
SELECT status, count(*) FROM reservations GROUP BY status;
SELECT * FROM v_waiting_queue WHERE status = 'WAITING';
```

### 4. User login (≈ 20 s)
On the login page, click **Rohan Sharma** in *Quick demo login*. The
dashboard shows upcoming bookings and vehicles.

### 5. Parking search (≈ 40 s)
**Find & Book** → vehicle *Tata Nexon EV*, location *Phoenix Marketcity*,
**the day after tomorrow** 17:00–19:00. (Don't use tomorrow evening: Rohan's Nexon is already
booked at Chennai Central tomorrow 18:00–20:00, so the database would refuse it with
*"This vehicle already has a reservation during this time"*. That is a nice extra point
if the examiner asks.) Point out:
- only SUV-size and compatible EV slots appear;
- the prices include the evening peak;
- the "Free now" badge is **physical** status, which is different from future availability.

### 6. Successful booking (≈ 40 s)
Reserve **E03** → reservation page with a 10-minute countdown (HELD) →
**Pay** → UPI → CONFIRMED. In psql:
```sql
SELECT reservation_id, status, total_amount FROM reservations ORDER BY reservation_id DESC LIMIT 1;
```

### 7–8. ⭐ Simultaneous booking and double-booking prevention (≈ 2 min) — THE HIGHLIGHT

**a) Website.** Log in as admin (*Ananya Iyer* card) → **Admin → Concurrency demo**.
- Choose slot 8, tomorrow 12:00–14:00, hold 2 s, then press **Run**.
- Show the timeline: two different backend PIDs; A gets the lock; B waits about 2000 ms; B gets `SLOT_UNAVAILABLE`.
- The verdict says *"Active overlapping rows: 1"*.
- Switch on **NOWAIT** and run again: B fails instantly with `SLOT_BUSY`.

**b) Two psql terminals** (most convincing; the examiner can type it). Follow
`database/concurrency_demo.sql` part 1:
- T1: `BEGIN; SELECT fn_create_reservation(13,13,8,…);`
- T2: the same call **hangs**.
- T1: `COMMIT;`
- T2 immediately prints `ERROR: Slot Unavailable`.

**c) The constraint alone** (part 4 of the same file). Run a raw INSERT
with no lock and no function → `violates exclusion constraint
"ex_res_no_slot_overlap"`.

Say: *"Even if our application had a bug, PostgreSQL would still refuse the second booking."*

### 9. Trigger execution (≈ 1 min)
- **Trigger B:** the admin reservations list shows Rahul CHECKED_IN on A01, and `v_slot_overview` shows A01 OCCUPIED.
- **Trigger A:** open reservation #13 as admin → *Simulate check-out time* = end time + 70 min → **Check out**. The message shows fine **₹160** (2 started hours × ₹40 × 2), and the slot is back to FREE.
- **Audit:** **Admin → Audit log** shows every status change, written by triggers.

### 10. Dynamic pricing (≈ 30 s) — psql
```sql
SELECT * FROM fn_calculate_price(1,'REGULAR',NULL,'2030-01-09 13:00+05:30','2030-01-09 15:00+05:30'); -- 80
SELECT * FROM fn_calculate_price(1,'REGULAR',NULL,'2030-01-09 17:00+05:30','2030-01-09 19:00+05:30'); -- 120
SELECT * FROM fn_calculate_price(1,'EV','DC','2030-01-09 13:00+05:30','2030-01-09 15:00+05:30');    -- 380
```
Optionally change a rate under **Admin → Pricing** and repeat.

### 11. Waiting-list progression (≈ 1 min)
- Admin → **Waiting list**: Arjun (priority 3) is #1 even though Meera asked earlier.
- Admin → Reservations → cancel **#14** (Rohan, Chennai Central, tomorrow 18:00).
- Waiting list: Arjun is now **OFFERED** with a 10-minute countdown.
- Log in as **Arjun** (demo card): the dashboard shows "A slot is available for you!" → pay.
- Optional: instead of paying, in psql
  ```sql
  UPDATE reservations SET hold_expires_at = now() WHERE source = 'WAITLIST' AND status = 'HELD';
  CALL sp_run_scheduled_jobs();
  ```
  → Arjun EXPIRED, Meera OFFERED.

### 12. Faulty-charger scenario (≈ 45 s)
- Admin → **Chargers** → Phoenix Marketcity E03 → type "Connector damaged" → **Faulty**. If you booked E03 in step 6, the message says 1 booking was cancelled and refunded.
- As Rohan: My Bookings shows CANCELLED with reason "Charger fault"; the waiting list shows a priority-4 entry.
- Search for E03 again: it is not offered.
- Admin → **Repaired** → Rohan immediately gets an offer for E03.

### 13. Admin dashboard (≈ 30 s)
Occupancy per location, statuses, revenue, faulty chargers, recent
trigger activity, and **Run scheduled jobs now**.

### Finish with the tests (≈ 30 s)
```
pytest -v
```
52 tests, including real concurrent bookings, all pass.

---

## If something goes wrong

| Problem | Fix |
|---|---|
| A demo slot is already booked from an earlier run | `python scripts/init_db.py --seed-only` |
| Times look wrong | All times are India time. Make sure your laptop's clock is correct. |
| The concurrency demo says "Demo users missing" | Reload the seed (as above) |
| A psql terminal is stuck in a transaction | Type `ROLLBACK;` |
