# Test Cases

**Run all tests:** `pytest -v` from the project folder. Set `TEST_DATABASE_URL` in `.env` first.

How the suite works:

- It uses a **separate database**, which it drops and rebuilds when the run starts.
- It reloads `seed.sql` **before every test**, so each test starts from identical data and the results are reproducible.
- Concurrency tests open real, separate PostgreSQL connections, synchronised with `threading.Barrier`.

## Execution record

| | |
|---|---|
| Date | 21 Oct 2026 |
| Environment | Ubuntu Linux, Python 3.14.4, PostgreSQL 18.6, psycopg 3.3.6, Flask 3.1.3 |
| Command | `pytest -v` |
| Result | **52 passed in 17.7 s** (0 failed) |

The "Actual" lines below record this run. Re-run on your own machine
before the viva and update them if anything differs.

Seed IDs used below: Rohan = user 2, Rahul = 4, Arjun = 6 (accessibility
permit), Demo User A = 13, Demo User B = 14. Slot 8 = Phoenix Marketcity
E03 (DC charger), slot 5 = Phoenix Marketcity A05 (regular, SUV size).

---

### T01 — User registration
- **Objective:** a new user can register; the password is hashed; duplicates are refused.
- **Input:** name "Test Driver", email `Test.Driver@Example.in`, phone 9123456780, password `Secret123`, vehicle `tn 05 xy 4321` (EV, CCS2).
- **Setup:** seeded database.
- **Steps:** POST `/register`; read USERS and VEHICLES; POST again with the same email.
- **Expected:** redirect to /login; email stored lower-case; `password_hash` starts with `scrypt:`; plate normalised to `TN05XY4321`; second attempt → HTTP 409 "already exists".
- **Pass if:** all of the above hold.
- **Test:** `tests/test_booking.py::test_T01_user_registration`
- **Actual:** PASSED.

### T02 — Valid login and role-based access
- **Objective:** a correct password logs in, a wrong one does not, and normal users cannot open admin pages.
- **Input:** `rohan.sharma@example.in` with a wrong password, then with `Password@123`; then the admin account.
- **Steps:** POST `/login`; GET `/dashboard`, `/admin/`; POST `/admin/api/concurrency-demo`.
- **Expected:** wrong password → 401. User → redirect to /dashboard, `/admin/` → 403, admin API → 403. Admin → redirect to `/admin/`, 200.
- **Test:** `test_booking.py::test_T02_login`, `test_quick_demo_login`
- **Actual:** PASSED.

### T03 — Search available slots
- **Objective:** search returns only slots that are free for the whole period, fit the vehicle, and have a working, compatible charger.
- **Input:** Rohan's Nexon EV (SUV, CCS2), location 1, day after tomorrow 10:00–12:00.
- **Steps:** `SELECT * FROM fn_search_available_slots(start, end, 1, NULL, NULL, NULL, 1)`, plus a DC-only filter, plus GET `/api/slots/search`.
- **Expected:** exactly A05, E01, E02, E03. CAR-size slots and the bike slot are excluded. Slots with faulty chargers never appear. The API returns `count = 4`.
- **Test:** `test_booking.py::test_T03_search_available_slots`
- **Actual:** PASSED (4 slots: A05, E01, E02, E03).

### T04 — Successful reservation
- **Objective:** booking creates a HELD reservation priced by the database; payment confirms it.
- **Input:** POST `/api/reservations` `{slot 8, vehicle 1, 12:00–14:00, "total_amount": 1}`, i.e. with a fake price.
- **Steps:** create, then POST `/reservations/<id>/pay` with method UPI.
- **Expected:** 201; status HELD with `hold_expires_at`; total > ₹1 (the client price is ignored). After paying: CONFIRMED, payment SUCCESS with amount = total. Slot `occupancy_status` is still FREE.
- **Test:** `test_booking.py::test_T04_successful_reservation`
- **Actual:** PASSED.

### T05 — Two users booking the same slot concurrently ⭐
- **Objective:** at most one of several simultaneous conflicting bookings succeeds.
- **Setup:** separate connections, one per user, released together by a barrier.
- **Cases:**
  1. *Hold:* A and B book slot 8 for the same time. The winner sleeps 1.5 s before COMMIT. → one OK, one `SLOT_UNAVAILABLE`, and the loser's wait is ≥ 1.0 s (it was blocked on the row lock).
  2. *Race:* 2 users, then 6 users, fire with no delay, 15 rounds each. → exactly 1 success per round; every failure is `SLOT_UNAVAILABLE`.
  3. *NOWAIT:* → one OK, one `SLOT_BUSY` in under 0.5 s (no waiting).
  4. *Demo service:* `run_concurrency_demo` → `successful_bookings = 1`, two different `backend_pid`s.
- **Verification query (after each case):** count of ACTIVE reservations overlapping that slot and time = **1**.
- **Test:** `test_concurrency.py::test_T05_*` (5 tests)
- **Actual:** PASSED, all 5. The CLI `scripts/concurrency_demo.py --race 30` also gave 30/30 rounds with exactly one success.

### T06 — Booking different slots simultaneously
- **Objective:** row-level locks on different slots do not block each other.
- **Input:** A books slot 8 and B books slot 7 at the same instant; each keeps its transaction open for 1 s.
- **Expected:** both OK; total time < 1.8 s, i.e. they ran in parallel rather than one after the other (≈ 2 s).
- **Test:** `test_concurrency.py::test_T06_different_slots_simultaneously`
- **Actual:** PASSED.

### T07 — Overlapping reservation intervals
- **Objective:** any overlap with an existing active booking is rejected.
- **Setup:** slot 5 booked 10:00–12:00.
- **Inputs:** 11–13, 9–11, 10–12, 10:30–11:30, 9–13.
- **Expected:** each → `SLOT_UNAVAILABLE`; still exactly 1 active row.
- **Test:** `test_booking.py::test_T07_overlapping_intervals_rejected` (5 parameterised cases)
- **Actual:** PASSED (5/5).

### T08 — Non-overlapping reservation intervals
- **Objective:** back-to-back bookings are allowed, because ranges are `[start, end)`.
- **Setup:** slot 5 booked 10:00–12:00.
- **Inputs:** 12:00–14:00 and 08:00–10:00.
- **Expected:** both succeed; 3 HELD rows on the slot.
- **Extra:** the same vehicle booking a different slot 11:00–13:00 → `VEHICLE_ALREADY_BOOKED`.
- **Test:** `test_T08_non_overlapping_intervals_accepted`, `test_T08b_same_vehicle_cannot_be_in_two_places`
- **Actual:** PASSED.

### T09 — Reservation cancellation
- **Objective:** the owner can cancel; the payment is refunded; the slot can be booked again.
- **Steps:** book and pay; another user tries to cancel; the owner cancels; another user books the same time; the owner cancels again.
- **Expected:** other user → `RESERVATION_NOT_FOUND`. Owner → refund = amount paid, reservation CANCELLED, payment REFUNDED. Rebooking succeeds. Second cancel → `CANNOT_CANCEL`.
- **Test:** `test_booking.py::test_T09_cancellation`
- **Actual:** PASSED.

### T10 — Temporary hold expiry
- **Objective:** an unpaid hold expires, and paying after expiry is refused.
- **Steps:** book; set `hold_expires_at = now() - 1 s` (simulates 10 minutes passing); try to pay; run `fn_run_expiry_jobs()` twice.
- **Expected:** payment → `HOLD_EXPIRED`. First run: `expired_holds ≥ 1`, status EXPIRED. Second run: 0 changes (idempotent). Seeded expired hold #19 is also EXPIRED.
- **Extra (no-show):** a CONFIRMED booking whose start was 2 h ago → NO_SHOW.
- **Test:** `test_triggers.py::test_T10_hold_expiry`, `test_T10b_no_show`
- **Actual:** PASSED.

### T11 — Automatic slot release
- **Objective:** an expired hold stops blocking the slot.
- **Steps:** A holds slot 5; B's search does not list it and B's booking fails; A's hold expires; search and booking again **without** running the scheduler.
- **Expected:** after expiry the slot is listed, B's booking succeeds, and A's row becomes EXPIRED (`fn_create_reservation` releases stale holds on the slot it locks).
- **Test:** `test_triggers.py::test_T11_automatic_slot_release`
- **Actual:** PASSED.

### T12 — Dynamic peak-hour pricing
- **Objective:** prices follow the peak windows in `peak_hours`, calculated per 15 minutes.
- **Input:** `fn_calculate_price(1, 'REGULAR', NULL, …)` at ₹40/h on fixed dates (Wed 9 Jan 2030, Sat 12 Jan 2030, IST).

| Window | Expected | Reason |
|---|---|---|
| Wed 13–15 | ₹80 | off-peak |
| Wed 17–19 | ₹120 | evening ×1.5 |
| Wed 16–18 | ₹100 | 40 + 60 |
| Wed 09–10 | ₹60 | weekday morning ×1.5 |
| Sat 09–10 | ₹40 | weekday peak does not apply on Saturday |
| Sat 12–14 | ₹100 | weekend ×1.25 |
| Wed 13:00–13:45 | ₹30 | pro-rata |

- **Extra:** an admin changes the rate to ₹50 and the evening multiplier to 2.0 → new quotes ₹100 (off-peak 2 h) and ₹100 (1 h peak).
- **Test:** `test_pricing.py::test_T12_*` (8 cases)
- **Actual:** PASSED (8/8).

### T13 — Charger-type pricing
- **Input:** Wed 13–15, location 1.
- **Expected:**
  - AC: parking 80 + charging 120 = **₹200**; DC: 80 + 300 = **₹380**.
  - DC 18–20 (peak) = **₹570**.
  - VIT (location rules ₹20 parking, ₹40 AC): 40 + 80.
  - Lower Parel (₹80 parking, ₹180 DC): 160 + 360.
  - Errors: EV without a charger type, end before start, and no active rule → `NO_PRICING_RULE`.
- **Test:** `test_pricing.py::test_T13_*`
- **Actual:** PASSED.

### T14 — Overstay fine calculation (Trigger A)
- **Objective:** the fine is computed by the trigger at check-out.
- **Rule:** 15-minute grace. After that, every started hour past the end time costs ₹40 × 2.
- **Steps:** book from now, pay, check in, then admin check-out at end + N minutes.

| N (minutes late) | Expected fine |
|---|---|
| −20 | ₹0 |
| 10 | ₹0 |
| 15 | ₹0 (boundary) |
| 16 | ₹80 |
| 70 | ₹160 |
| 150 | ₹240 |

- **Also:** total = fees + fine; balance due = fine; after paying the fine the balance is 0. Seed rows #2 = ₹160, #3 = ₹0, #4 = ₹240.
- **Test:** `test_triggers.py::test_T14_overstay_fine` (6 cases), `test_T14_seeded_fines`
- **Actual:** PASSED (7/7).

### Trigger B — slot occupancy (supporting)
- A future CONFIRMED booking leaves the slot FREE. Check-in → OCCUPIED. Check-out → FREE.
- If the previous car is still on the slot, the next check-in → `SLOT_OCCUPIED`.
- **Test:** `test_trigger_B_slot_occupancy`, `test_checkin_refused_while_previous_car_still_there`
- **Actual:** PASSED.

### T15 — Waiting-list insertion
- **Setup:** Chennai Central's two DC chargers are both booked tomorrow 18–20.
- **Steps and expected results:**
  - Demo A joins → WAITING, priority 1.
  - Joins again → `ALREADY_WAITING`.
  - Tries to join where a slot is free → `SLOTS_AVAILABLE`.
  - Petrol car asks for an EV slot → `VEHICLE_INCOMPATIBLE`.
  - Demo B joins via POST `/api/waiting-list` → 201.
- **Test:** `test_waiting_list.py::test_T15_join_waiting_list`
- **Actual:** PASSED.

### T16 — Waiting-list priority ordering
- **Seed queue:** Arjun (priority 3), Meera (1, earliest), Divya (1, later).
- **Step:** Rohan (PREMIUM, priority 2) joins **last**.
- **Expected:** order Arjun, Rohan, Meera, Divya; priorities [3, 2, 1, 1]; positions 1–4.
- **Test:** `test_waiting_list.py::test_T16_priority_ordering`
- **Actual:** PASSED.

### T17 — Automatic waiting-list progression
- **Steps and expected results:**
  1. Priya cancels her DC booking → Arjun OFFERED (WAITLIST reservation, HELD); Meera and Divya still WAITING.
  2. Arjun's offer expires and the expiry job runs → Arjun EXPIRED; `offers_made = 1`; Meera OFFERED.
  3. Meera pays → her reservation CONFIRMED and her entry ACCEPTED.
  4. Divya is now position 1.
- **Extra:**
  - Two queue workers run at the same instant after one slot frees → exactly one offer (`[0, 1]`).
  - Declining an offer → entry CANCELLED and the next user is OFFERED.
- **Test:** `test_T17_progression`, `test_T17b_two_queue_workers_never_offer_the_same_slot`, `test_offer_decline_moves_queue`
- **Actual:** PASSED.

### T18 — Faulty charger blocks reservations (Trigger C)
- **Steps:** Demo A books and pays slot 8; `CALL sp_mark_charger_faulty(3, …)`.
- **Expected:**
  - The booking is CANCELLED with reason "Charger fault…" and its payment REFUNDED.
  - A waiting-list entry with priority 4 (DC, location 1) is created.
  - An open maintenance ticket exists.
  - A new booking → `CHARGER_FAULTY`, both via the function **and** via a raw INSERT.
  - Search no longer lists the slot.
- **Test:** `test_triggers.py::test_T18_faulty_charger_blocks_reservations`
- **Actual:** PASSED.

### T19 — Charger repair restores bookability
- **Steps:** after T18's setup, `CALL sp_mark_charger_repaired(3, 'Breaker replaced')`.
- **Expected:**
  - The charger is OPERATIONAL again.
  - The ticket is closed with the note.
  - The displaced priority-4 driver is automatically OFFERED the repaired slot (WAITLIST, HELD).
  - Other users can book it again.
- **Test:** `test_triggers.py::test_T19_repair_restores_bookability`
- **Actual:** PASSED.

### T20 — Foreign-key and integrity constraint violations
Each statement must fail with the stated error:

| Statement | Expected error |
|---|---|
| Vehicle for user 9999 | ForeignKeyViolation |
| Slot for location 9999 | ForeignKeyViolation |
| Duplicate email | UniqueViolation |
| Phone "12345" | CheckViolation |
| EV without connector | CheckViolation |
| 150 kW AC CCS2 charger | CheckViolation |
| end < start | DataException (raised while building `booking_period`) |
| DELETE location 1 | RestrictViolation (`ON DELETE RESTRICT`) |
| status = 'FLYING' | CheckViolation |
| Second `booking_policy` row | CheckViolation |
| Reservation for a vehicle the user does not own | trigger error |
| Raw INSERT of an overlapping active reservation, bypassing all application code | **ExclusionViolation** |

- **Also:** deleting a vehicle that has bookings via the website shows a friendly RESTRICT message (`test_vehicle_with_bookings_cannot_be_deleted`), and invalid booking inputs give the right codes (`test_invalid_booking_inputs`).
- **Test:** `test_booking.py::test_T20_integrity_constraints`
- **Actual:** PASSED.

---

## Manual / SQL-level tests

- `database/demo_queries.sql` — run section by section in psql. Each section states its expected output. It was executed on 21 Oct 2026 and every section matched.
- `database/concurrency_demo.sql` — two-terminal test. Executed with two psql processes: Terminal 2 blocked for **2.0 s** until Terminal 1 committed, then received `SLOT_UNAVAILABLE`.
