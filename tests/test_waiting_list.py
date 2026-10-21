"""T15, T16, T17 — the priority waiting list.

Seed situation: Chennai Central Metro (location 3) has only two DC chargers,
and both are CONFIRMED tomorrow 18:00–20:00 (reservations #14 Rohan, #15 Priya).
Waiting: Meera (priority 1, asked 50 min ago), Arjun (priority 3, 30 min ago),
Divya (priority 1, 20 min ago).
"""
import threading

import pytest
from psycopg import errors

from services.timeutil import IST
from tests.conftest import ARJUN, DEMO_A, DIVYA, MEERA, ROHAN, VEH, hint_of, local


def window(db):
    return db.execute("SELECT start_time, end_time FROM reservations WHERE reservation_id = 14").fetchone()


def queue(db):
    return db.execute("""SELECT user_id, priority, status, queue_position FROM v_waiting_queue
                         WHERE status = 'WAITING' ORDER BY queue_position""").fetchall()


def entry(db, user):
    return db.execute("SELECT * FROM waiting_list WHERE user_id = %s ORDER BY entry_id DESC LIMIT 1", (user,)).fetchone()


# --------------------------------------------------------------------------
# T15 Waiting-list insertion
# --------------------------------------------------------------------------
def test_T15_join_waiting_list(db, client):
    w = window(db)
    with db.transaction():
        eid = db.execute("SELECT fn_join_waiting_list(%s, %s, 3, 'EV', 'DC', %s, %s) AS id",
                         (DEMO_A, VEH["demo_a_ev"], w["start_time"], w["end_time"])).fetchone()["id"]
    e = db.execute("SELECT * FROM waiting_list WHERE entry_id = %s", (eid,)).fetchone()
    assert e["status"] == "WAITING" and e["priority"] == 1

    # Same vehicle, overlapping time again -> ALREADY_WAITING (EXCLUDE constraint)
    with pytest.raises(errors.RaiseException) as ex, db.transaction():
        db.execute("SELECT fn_join_waiting_list(%s, %s, 3, 'EV', 'DC', %s, %s)",
                   (DEMO_A, VEH["demo_a_ev"], w["start_time"], w["end_time"]))
    assert hint_of(ex) == "ALREADY_WAITING"

    # Not allowed when a compatible slot IS free (the user should just book)
    with pytest.raises(errors.RaiseException) as ex, db.transaction():
        db.execute("SELECT fn_join_waiting_list(%s, %s, 1, 'EV', NULL, %s, %s)",
                   (DEMO_A, VEH["demo_a_ev"], local(3, 10), local(3, 12)))
    assert hint_of(ex) == "SLOTS_AVAILABLE"

    # Petrol car cannot wait for an EV slot
    with pytest.raises(errors.RaiseException) as ex, db.transaction():
        db.execute("SELECT fn_join_waiting_list(%s, %s, 3, 'EV', 'DC', %s, %s)",
                   (ROHAN, VEH["rohan_car"], w["start_time"], w["end_time"]))
    assert hint_of(ex) == "VEHICLE_INCOMPATIBLE"

    # Through the HTTP API (the form sends India-time "YYYY-MM-DDTHH:MM")
    client.post("/login", data={"email": "demo.b@example.in", "password": "Password@123"})
    fmt = "%Y-%m-%dT%H:%M"
    resp = client.post("/api/waiting-list", json={
        "vehicle_id": VEH["demo_b_ev"], "location_id": 3, "slot_type": "EV", "charger_type": "DC",
        "start": w["start_time"].astimezone(IST).strftime(fmt), "end": w["end_time"].astimezone(IST).strftime(fmt)})
    assert resp.status_code == 201, resp.json


# --------------------------------------------------------------------------
# T16 Waiting-list priority ordering
# --------------------------------------------------------------------------
def test_T16_priority_ordering(db):
    # Seed order: Arjun (p3) first, then Meera (p1, earlier), then Divya (p1, later)
    assert [r["user_id"] for r in queue(db)] == [ARJUN, MEERA, DIVYA]

    # Rohan is PREMIUM (priority 2). He joins LAST but must go ahead of the priority-1 users.
    w = window(db)
    with db.transaction():
        db.execute("SELECT fn_join_waiting_list(%s, %s, 3, 'EV', 'DC', %s, %s)",
                   (ROHAN, VEH["rohan_ev"], w["start_time"], w["end_time"]))
    q = queue(db)
    assert [r["user_id"] for r in q] == [ARJUN, ROHAN, MEERA, DIVYA]
    assert [r["priority"] for r in q] == [3, 2, 1, 1]
    assert [r["queue_position"] for r in q] == [1, 2, 3, 4]


# --------------------------------------------------------------------------
# T17 Automatic waiting-list progression
# --------------------------------------------------------------------------
def test_T17_progression(db):
    # 1. Priya cancels #15 -> the freed DC charger is OFFERED to the head of the queue (Arjun)
    with db.transaction():
        db.execute("SELECT fn_cancel_reservation(15, 5)")
    a = entry(db, ARJUN)
    assert a["status"] == "OFFERED"
    offer = db.execute("SELECT * FROM reservations WHERE reservation_id = %s", (a["offered_reservation_id"],)).fetchone()
    assert offer["status"] == "HELD" and offer["source"] == "WAITLIST" and offer["user_id"] == ARJUN
    assert entry(db, MEERA)["status"] == "WAITING" and entry(db, DIVYA)["status"] == "WAITING"

    # 2. Arjun does not pay in time -> offer expires -> the next user (Meera) gets it
    db.execute("UPDATE reservations SET hold_expires_at = now() - interval '1 second' WHERE reservation_id = %s",
               (offer["reservation_id"],))
    with db.transaction():
        jobs = db.execute("SELECT * FROM fn_run_expiry_jobs()").fetchone()
    assert jobs["expired_holds"] >= 1 and jobs["offers_made"] == 1
    assert entry(db, ARJUN)["status"] == "EXPIRED"
    m = entry(db, MEERA)
    assert m["status"] == "OFFERED"

    # 3. Meera pays -> reservation CONFIRMED and her entry ACCEPTED (sync trigger)
    with db.transaction():
        db.execute("SELECT fn_make_payment(%s, %s, 'UPI')", (m["offered_reservation_id"], MEERA))
    assert entry(db, MEERA)["status"] == "ACCEPTED"
    assert db.execute("SELECT status FROM reservations WHERE reservation_id = %s",
                      (m["offered_reservation_id"],)).fetchone()["status"] == "CONFIRMED"

    # 4. Divya is now first in line
    assert [(r["user_id"], r["queue_position"]) for r in queue(db)] == [(DIVYA, 1)]


def test_T17b_two_queue_workers_never_offer_the_same_slot(db, new_conn):
    """Free ONE slot, then run fn_process_waiting_list from two connections at
    the same instant. Exactly one offer must be made."""
    db.execute("UPDATE reservations SET status = 'CANCELLED', cancel_reason = 'test' WHERE reservation_id = 15")
    barrier = threading.Barrier(2)
    made = []

    def worker():
        c = new_conn()
        barrier.wait()
        with c.transaction():
            made.append(c.execute("SELECT fn_process_waiting_list() AS n").fetchone()["n"])

    ts = [threading.Thread(target=worker) for _ in range(2)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(20)
    assert sorted(made) == [0, 1]
    assert db.execute("SELECT count(*) AS n FROM waiting_list WHERE status = 'OFFERED'").fetchone()["n"] == 1


def test_offer_decline_moves_queue(db):
    with db.transaction():
        db.execute("SELECT fn_cancel_reservation(14, 2)")        # Rohan cancels -> Arjun offered
    a = entry(db, ARJUN)
    assert a["status"] == "OFFERED"
    with db.transaction():                                         # Arjun declines (cancels the offer)
        db.execute("SELECT fn_cancel_reservation(%s, %s)", (a["offered_reservation_id"], ARJUN))
    assert entry(db, ARJUN)["status"] == "CANCELLED"
    assert entry(db, MEERA)["status"] == "OFFERED"
