"""T10, T11, T14, T18, T19 + trigger B (slot occupancy) and the audit trigger."""
from datetime import timedelta

import pytest
from psycopg import errors

from tests.conftest import ADMIN_ID, DEMO_A, DEMO_B, RAHUL, ROHAN, VEH, book, hint_of, local, slot_id


def status_of(db, rid):
    return db.execute("SELECT status FROM reservations WHERE reservation_id = %s", (rid,)).fetchone()["status"]


def occupancy(db, sid):
    return db.execute("SELECT occupancy_status FROM parking_slots WHERE slot_id = %s", (sid,)).fetchone()["occupancy_status"]


def start_now_session(db, user, vehicle, sid, hours=1):
    """Book a slot starting right now, pay, and check in. Returns reservation_id."""
    row = db.execute("SELECT now() AS t").fetchone()
    rid = book(db, user, vehicle, sid, row["t"], row["t"] + timedelta(hours=hours))
    with db.transaction():
        db.execute("SELECT fn_make_payment(%s, %s, 'UPI')", (rid, user))
        db.execute("SELECT fn_check_in(%s, %s)", (rid, user))
    return rid


def run_jobs(db):
    with db.transaction():
        return db.execute("SELECT * FROM fn_run_expiry_jobs()").fetchone()


# --------------------------------------------------------------------------
# T10 Temporary hold expiry
# --------------------------------------------------------------------------
def test_T10_hold_expiry(db):
    s = slot_id(db, 1, "A05")
    rid = book(db, ROHAN, VEH["rohan_car"], s, local(2, 10), local(2, 12))
    assert status_of(db, rid) == "HELD"

    # Simulate the 10-minute hold running out
    db.execute("UPDATE reservations SET hold_expires_at = now() - interval '1 second' WHERE reservation_id = %s", (rid,))

    # Paying after expiry is refused
    with pytest.raises(errors.RaiseException) as ex, db.transaction():
        db.execute("SELECT fn_make_payment(%s, %s, 'UPI')", (rid, ROHAN))
    assert hint_of(ex) == "HOLD_EXPIRED"

    first = run_jobs(db)
    assert first["expired_holds"] >= 1
    assert status_of(db, rid) == "EXPIRED"

    # Idempotent: running again changes nothing
    second = run_jobs(db)
    assert second["expired_holds"] == 0 and status_of(db, rid) == "EXPIRED"

    # The seed also contains an expired hold (#19) — it must be expired too
    assert status_of(db, 19) == "EXPIRED"


def test_T10b_no_show(db):
    # A CONFIRMED booking whose start + 30 min passed without check-in becomes NO_SHOW
    rid = 16
    db.execute("""UPDATE reservations SET start_time = now() - interval '2 hours',
                  end_time = now() + interval '1 hour' WHERE reservation_id = %s""", (rid,))
    run_jobs(db)
    assert status_of(db, rid) == "NO_SHOW"


# --------------------------------------------------------------------------
# T11 Automatic slot release after expiry
# --------------------------------------------------------------------------
def test_T11_automatic_slot_release(db):
    s = slot_id(db, 1, "A05")
    start, end = local(2, 10), local(2, 12)
    rid = book(db, ROHAN, VEH["rohan_car"], s, start, end)

    def listed():
        rows = db.execute("SELECT slot_id FROM fn_search_available_slots(%s, %s, 1)", (start, end)).fetchall()
        return s in {r["slot_id"] for r in rows}

    assert not listed(), "held slot must not be offered to others"
    with pytest.raises(errors.RaiseException) as ex:
        book(db, RAHUL, VEH["rahul_car"], s, start, end)
    assert hint_of(ex) == "SLOT_UNAVAILABLE"

    db.execute("UPDATE reservations SET hold_expires_at = now() - interval '1 second' WHERE reservation_id = %s", (rid,))
    assert listed(), "an expired hold no longer blocks the search"
    # Booking works even BEFORE the scheduler runs: fn_create_reservation releases stale holds on that slot.
    new_id = book(db, RAHUL, VEH["rahul_car"], s, start, end)
    assert status_of(db, rid) == "EXPIRED" and status_of(db, new_id) == "HELD"


# --------------------------------------------------------------------------
# Trigger B — physical occupancy follows check-in / check-out only
# --------------------------------------------------------------------------
def test_trigger_B_slot_occupancy(db):
    s = slot_id(db, 1, "A05")
    # A FUTURE confirmed booking must NOT mark the slot occupied
    fut = book(db, RAHUL, VEH["rahul_car"], s, local(3, 10), local(3, 12))
    with db.transaction():
        db.execute("SELECT fn_make_payment(%s, %s, 'UPI')", (fut, RAHUL))
    assert occupancy(db, s) == "FREE"

    rid = start_now_session(db, ROHAN, VEH["rohan_car"], s)
    assert occupancy(db, s) == "OCCUPIED"

    with db.transaction():
        db.execute("SELECT * FROM fn_check_out(%s, %s)", (rid, ROHAN))
    assert occupancy(db, s) == "FREE"
    assert status_of(db, rid) == "COMPLETED"


def test_checkin_refused_while_previous_car_still_there(db):
    s = slot_id(db, 1, "A01")        # seed: Rahul is CHECKED_IN on A01 right now
    assert occupancy(db, s) == "OCCUPIED"
    # Force a next booking that starts now on the same slot (as if Rahul overstayed)
    db.execute("UPDATE reservations SET end_time = now() - interval '1 minute', start_time = now() - interval '3 hours' WHERE reservation_id = 13")
    row = db.execute("SELECT now() AS t").fetchone()
    rid = book(db, ROHAN, VEH["rohan_car"], s, row["t"], row["t"] + timedelta(hours=1))
    with db.transaction():
        db.execute("SELECT fn_make_payment(%s, %s, 'UPI')", (rid, ROHAN))
    with pytest.raises(errors.RaiseException) as ex, db.transaction():
        db.execute("SELECT fn_check_in(%s, %s)", (rid, ROHAN))
    assert hint_of(ex) == "SLOT_OCCUPIED"


# --------------------------------------------------------------------------
# T14 Overstay fine calculation (trigger A)
# --------------------------------------------------------------------------
@pytest.mark.parametrize("late_minutes,expected_fine", [
    (-20, 0),      # left early
    (10, 0),       # inside the 15-minute grace period
    (15, 0),       # exactly at the grace limit
    (16, 80),      # 1 started hour × ₹40 × 2
    (70, 160),     # 2 started hours × ₹40 × 2
    (150, 240),    # 3 started hours × ₹40 × 2
])
def test_T14_overstay_fine(db, late_minutes, expected_fine):
    s = slot_id(db, 1, "A05")                       # Phoenix Marketcity: default parking rate ₹40/h
    rid = start_now_session(db, ROHAN, VEH["rohan_car"], s)
    end = db.execute("SELECT end_time FROM reservations WHERE reservation_id = %s", (rid,)).fetchone()["end_time"]
    with db.transaction():
        bill = db.execute("SELECT * FROM fn_check_out(%s, %s, TRUE, %s)",
                          (rid, ADMIN_ID, end + timedelta(minutes=late_minutes))).fetchone()
    assert bill["overstay_fine"] == expected_fine
    assert bill["total_amount"] == bill["parking_fee"] + bill["charging_fee"] + expected_fine
    assert bill["balance_due"] == expected_fine          # booking already paid; only the fine is due
    if expected_fine:
        with db.transaction():
            db.execute("SELECT fn_make_payment(%s, %s, 'UPI')", (rid, ROHAN))
        assert db.execute("SELECT balance_due FROM fn_final_bill(%s)", (rid,)).fetchone()["balance_due"] == 0


def test_T14_seeded_fines(db):
    # Seed reservation #2: 70 min late, ₹40/h -> ₹160 ; #4: 150 min late -> ₹240 ; #3: 10 min late -> ₹0
    fines = {r["reservation_id"]: r["overstay_fine"] for r in
             db.execute("SELECT reservation_id, overstay_fine FROM reservations WHERE reservation_id IN (2,3,4)")}
    assert fines == {2: 160, 3: 0, 4: 240}


# --------------------------------------------------------------------------
# T18 Faulty charger blocks reservations (trigger C)
# --------------------------------------------------------------------------
def _charger_on(db, loc, code):
    return db.execute("SELECT charger_id FROM chargers c JOIN parking_slots s USING (slot_id) "
                      "WHERE s.location_id = %s AND s.slot_code = %s", (loc, code)).fetchone()["charger_id"]


def test_T18_faulty_charger_blocks_reservations(db):
    s = slot_id(db, 1, "E03")
    cid = _charger_on(db, 1, "E03")
    rid = book(db, DEMO_A, VEH["demo_a_ev"], s, local(2, 12), local(2, 14))
    with db.transaction():
        db.execute("SELECT fn_make_payment(%s, %s, 'UPI')", (rid, DEMO_A))

    with db.transaction():
        db.execute("CALL sp_mark_charger_faulty(%s, 'Connector melted', %s)", (cid, ADMIN_ID))

    # 1. Affected future booking is cancelled and refunded
    r = db.execute("SELECT status, cancel_reason FROM reservations WHERE reservation_id = %s", (rid,)).fetchone()
    assert r["status"] == "CANCELLED" and "Charger fault" in r["cancel_reason"]
    assert db.execute("SELECT status FROM payments WHERE reservation_id = %s", (rid,)).fetchone()["status"] == "REFUNDED"
    # 2. The driver is put at the front of the waiting list (priority 4)
    w = db.execute("SELECT * FROM waiting_list WHERE vehicle_id = %s AND status = 'WAITING'", (VEH["demo_a_ev"],)).fetchone()
    assert w["priority"] == 4 and w["charger_type"] == "DC" and w["location_id"] == 1
    # 3. A maintenance ticket is open
    assert db.execute("SELECT count(*) AS n FROM charger_maintenance WHERE charger_id = %s AND resolved_at IS NULL",
                      (cid,)).fetchone()["n"] == 1
    # 4. New bookings are refused — through the function AND through a raw INSERT
    with pytest.raises(errors.RaiseException) as ex:
        book(db, DEMO_B, VEH["demo_b_ev"], s, local(3, 12), local(3, 14))
    assert hint_of(ex) == "CHARGER_FAULTY"
    with pytest.raises(errors.RaiseException) as ex, db.transaction():
        db.execute("""INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, hold_expires_at)
                      VALUES (%s, %s, %s, %s, %s, now() + interval '5 minutes')""",
                   (DEMO_B, VEH["demo_b_ev"], s, local(3, 12), local(3, 14)))
    assert hint_of(ex) == "CHARGER_FAULTY"
    # 5. Search does not list it
    rows = db.execute("SELECT slot_id FROM fn_search_available_slots(%s, %s, 1)", (local(3, 12), local(3, 14))).fetchall()
    assert s not in {x["slot_id"] for x in rows}


# --------------------------------------------------------------------------
# T19 Charger repair restores bookability
# --------------------------------------------------------------------------
def test_T19_repair_restores_bookability(db):
    s = slot_id(db, 1, "E03")
    cid = _charger_on(db, 1, "E03")
    rid = book(db, DEMO_A, VEH["demo_a_ev"], s, local(2, 12), local(2, 14))
    with db.transaction():
        db.execute("CALL sp_mark_charger_faulty(%s, 'Tripped breaker', %s)", (cid, ADMIN_ID))
    assert status_of(db, rid) == "CANCELLED"

    with db.transaction():
        db.execute("CALL sp_mark_charger_repaired(%s, 'Breaker replaced')", (cid,))

    assert db.execute("SELECT status FROM chargers WHERE charger_id = %s", (cid,)).fetchone()["status"] == "OPERATIONAL"
    t = db.execute("SELECT * FROM charger_maintenance WHERE charger_id = %s ORDER BY maintenance_id DESC LIMIT 1",
                   (cid,)).fetchone()
    assert t["resolved_at"] is not None and t["resolution_note"] == "Breaker replaced"

    # The displaced driver (priority 4) was offered the repaired charger automatically
    w = db.execute("SELECT * FROM waiting_list WHERE vehicle_id = %s ORDER BY entry_id DESC LIMIT 1",
                   (VEH["demo_a_ev"],)).fetchone()
    assert w["status"] == "OFFERED"
    offer = db.execute("SELECT * FROM reservations WHERE reservation_id = %s", (w["offered_reservation_id"],)).fetchone()
    assert offer["slot_id"] == s and offer["status"] == "HELD" and offer["source"] == "WAITLIST"

    # And anyone can book it again for other times
    book(db, DEMO_B, VEH["demo_b_ev"], s, local(3, 12), local(3, 14))


def test_seeded_faulty_chargers_and_audit(db):
    assert db.execute("SELECT count(*) AS n FROM chargers WHERE status = 'FAULTY'").fetchone()["n"] == 2
    # Every status change is audited by trigger
    s = slot_id(db, 1, "A05")
    rid = book(db, ROHAN, VEH["rohan_car"], s, local(2, 10), local(2, 12))
    with db.transaction():
        db.execute("SELECT fn_make_payment(%s, %s, 'UPI')", (rid, ROHAN))
    log = db.execute("""SELECT old_status, new_status FROM audit_logs
                        WHERE table_name = 'reservations' AND record_id = %s ORDER BY log_id""", (rid,)).fetchall()
    assert [(x["old_status"], x["new_status"]) for x in log] == [(None, "HELD"), ("HELD", "CONFIRMED")]
