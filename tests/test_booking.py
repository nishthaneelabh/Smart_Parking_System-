"""T01–T04, T07–T09, T20 — accounts, search, booking, overlaps, cancellation, integrity."""
from datetime import timedelta

import psycopg
import pytest
from psycopg import errors

from tests.conftest import (ARJUN, DEMO_A, MEERA, RAHUL, ROHAN, VEH, book, hint_of, local, slot_id)


# --------------------------------------------------------------------------
# T01 User registration
# --------------------------------------------------------------------------
def test_T01_user_registration(client, db):
    resp = client.post("/register", data={
        "full_name": "Test Driver", "email": "Test.Driver@Example.in", "phone": "9123456780",
        "password": "Secret123", "confirm_password": "Secret123",
        "registration_no": "tn 05 xy 4321", "model_name": "Tata Nexon EV", "vehicle_type": "SUV",
        "is_ev": "on", "connector_type": "CCS2",
    })
    assert resp.status_code == 302 and "/login" in resp.location
    user = db.execute("SELECT * FROM users WHERE email = 'test.driver@example.in'").fetchone()
    assert user is not None, "email must be stored lower-case"
    assert user["password_hash"].startswith("scrypt:"), "password must be hashed, never stored in plain text"
    veh = db.execute("SELECT * FROM vehicles WHERE user_id = %s", (user["user_id"],)).fetchone()
    assert veh["registration_no"] == "TN05XY4321" and veh["connector_type"] == "CCS2"

    # Duplicate email is rejected (UNIQUE constraint) with a friendly message
    resp = client.post("/register", data={
        "full_name": "Someone Else", "email": "test.driver@example.in", "phone": "9123456781",
        "password": "Secret123", "confirm_password": "Secret123"})
    assert resp.status_code == 409
    assert b"already exists" in resp.data


# --------------------------------------------------------------------------
# T02 Valid login (and invalid login, and role-based access)
# --------------------------------------------------------------------------
def test_T02_login(client):
    bad = client.post("/login", data={"email": "rohan.sharma@example.in", "password": "wrong"})
    assert bad.status_code == 401

    ok = client.post("/login", data={"email": "rohan.sharma@example.in", "password": "Password@123"})
    assert ok.status_code == 302 and ok.location.endswith("/dashboard")
    assert client.get("/dashboard").status_code == 200
    # A normal user must not reach admin pages or admin APIs
    assert client.get("/admin/").status_code == 403
    assert client.post("/admin/api/concurrency-demo", json={}).status_code == 403

    client.post("/logout")
    admin = client.post("/login", data={"email": "admin@smartpark.in", "password": "Admin@123"})
    assert admin.location.endswith("/admin/")
    assert client.get("/admin/").status_code == 200


# --------------------------------------------------------------------------
# T03 Search available slots
# --------------------------------------------------------------------------
def test_T03_search_available_slots(db, client):
    start, end = local(2, 10), local(2, 12)
    rows = db.execute("SELECT * FROM fn_search_available_slots(%s, %s, 1, NULL, NULL, NULL, %s)",
                      (start, end, VEH["rohan_ev"])).fetchall()
    codes = sorted(r["slot_code"] for r in rows)
    # Rohan's Nexon EV is an SUV with CCS2: fits the SUV regular slot A05 and the three EV slots
    # (E01/E02 are Type 2 AC — compatible with CCS2), but NOT the CAR-size A01–A03 or the BIKE slot A04.
    assert codes == ["A05", "E01", "E02", "E03"]
    assert all(r["est_total"] > 0 for r in rows)

    # Filter by charger type
    dc = db.execute("SELECT * FROM fn_search_available_slots(%s, %s, NULL, 'Chennai', 'EV', 'DC', %s)",
                    (start, end, VEH["rohan_ev"])).fetchall()
    assert dc and all(r["charger_type"] == "DC" and r["city"] == "Chennai" for r in dc)

    # Faulty chargers are never listed (VIT E02 and Orion E03 are FAULTY in the seed)
    every = db.execute("SELECT * FROM fn_search_available_slots(%s, %s)", (start, end)).fetchall()
    faulty_slots = {r["slot_id"] for r in db.execute(
        "SELECT slot_id FROM chargers WHERE status = 'FAULTY'").fetchall()}
    assert faulty_slots and not faulty_slots & {r["slot_id"] for r in every}

    # Same search through the HTTP API
    client.post("/login", data={"email": "rohan.sharma@example.in", "password": "Password@123"})
    resp = client.get("/api/slots/search", query_string={
        "start": start.strftime("%Y-%m-%dT%H:%M"), "end": end.strftime("%Y-%m-%dT%H:%M"),
        "location_id": 1, "vehicle_id": VEH["rohan_ev"]})
    assert resp.status_code == 200 and resp.json["count"] == 4


# --------------------------------------------------------------------------
# T04 Successful reservation
# --------------------------------------------------------------------------
def test_T04_successful_reservation(db, client):
    client.post("/login", data={"email": "rohan.sharma@example.in", "password": "Password@123"})
    start, end = local(2, 12), local(2, 14)
    resp = client.post("/api/reservations", json={
        "slot_id": slot_id(db, 1, "E03"), "vehicle_id": VEH["rohan_ev"],
        "start": start.strftime("%Y-%m-%dT%H:%M"), "end": end.strftime("%Y-%m-%dT%H:%M"),
        "total_amount": 1})                                    # a price sent by the client is IGNORED
    assert resp.status_code == 201, resp.json
    rid = resp.json["reservation_id"]
    r = db.execute("SELECT * FROM reservations WHERE reservation_id = %s", (rid,)).fetchone()
    assert r["status"] == "HELD" and r["hold_expires_at"] is not None
    assert r["total_amount"] > 1, "price must come from the database, not the client"

    # Pay -> CONFIRMED, payment row created with the database amount
    pay = client.post(f"/reservations/{rid}/pay", data={"method": "UPI"})
    assert pay.status_code == 302
    r = db.execute("SELECT status, total_amount FROM reservations WHERE reservation_id = %s", (rid,)).fetchone()
    p = db.execute("SELECT * FROM payments WHERE reservation_id = %s", (rid,)).fetchone()
    assert r["status"] == "CONFIRMED" and p["status"] == "SUCCESS" and p["amount"] == r["total_amount"]
    # The physical slot is still FREE — a future booking does not occupy it now
    occ = db.execute("SELECT occupancy_status FROM parking_slots WHERE slot_id = %s",
                     (slot_id(db, 1, "E03"),)).fetchone()
    assert occ["occupancy_status"] == "FREE"


# --------------------------------------------------------------------------
# T07 Overlapping reservation intervals are rejected
# --------------------------------------------------------------------------
@pytest.mark.parametrize("start_h,end_h", [(11, 13), (9, 11), (10, 12), (10.5, 11.5), (9, 13)])
def test_T07_overlapping_intervals_rejected(db, start_h, end_h):
    s = slot_id(db, 1, "A05")
    book(db, ROHAN, VEH["rohan_car"], s, local(3, 10), local(3, 12))          # existing 10:00–12:00
    h, m = int(start_h), int((start_h % 1) * 60)
    eh, em = int(end_h), int((end_h % 1) * 60)
    with pytest.raises(errors.RaiseException) as ex:
        book(db, RAHUL, VEH["rahul_car"], s, local(3, h, m), local(3, eh, em))
    assert hint_of(ex) == "SLOT_UNAVAILABLE"
    n = db.execute("""SELECT count(*) AS n FROM reservations WHERE slot_id = %s
                      AND status IN ('HELD','CONFIRMED','CHECKED_IN')""", (s,)).fetchone()["n"]
    assert n == 1


# --------------------------------------------------------------------------
# T08 Non-overlapping intervals are accepted (including back-to-back)
# --------------------------------------------------------------------------
def test_T08_non_overlapping_intervals_accepted(db):
    s = slot_id(db, 1, "A05")
    book(db, ROHAN, VEH["rohan_car"], s, local(3, 10), local(3, 12))
    book(db, RAHUL, VEH["rahul_car"], s, local(3, 12), local(3, 14))         # starts exactly when the first ends
    book(db, MEERA, VEH["meera_car"], s, local(3, 8), local(3, 10))          # ends exactly when the first starts
    n = db.execute("""SELECT count(*) AS n FROM reservations WHERE slot_id = %s AND status = 'HELD'""",
                   (s,)).fetchone()["n"]
    assert n == 3


def test_T08b_same_vehicle_cannot_be_in_two_places(db):
    book(db, ROHAN, VEH["rohan_car"], slot_id(db, 1, "A05"), local(3, 10), local(3, 12))
    with pytest.raises(errors.RaiseException) as ex:
        book(db, ROHAN, VEH["rohan_car"], slot_id(db, 2, "B03"), local(3, 11), local(3, 13))
    assert hint_of(ex) == "VEHICLE_ALREADY_BOOKED"


# --------------------------------------------------------------------------
# T09 Reservation cancellation (with refund, and the slot becomes bookable)
# --------------------------------------------------------------------------
def test_T09_cancellation(db):
    s = slot_id(db, 1, "A05")
    rid = book(db, ROHAN, VEH["rohan_car"], s, local(3, 10), local(3, 12))
    with db.transaction():
        db.execute("SELECT fn_make_payment(%s, %s, 'CARD')", (rid, ROHAN))
    paid = db.execute("SELECT amount FROM payments WHERE reservation_id = %s", (rid,)).fetchone()["amount"]

    # Someone else cannot cancel it
    with pytest.raises(errors.RaiseException) as ex, db.transaction():
        db.execute("SELECT fn_cancel_reservation(%s, %s)", (rid, RAHUL))
    assert hint_of(ex) == "RESERVATION_NOT_FOUND"

    with db.transaction():
        refund = db.execute("SELECT fn_cancel_reservation(%s, %s) AS r", (rid, ROHAN)).fetchone()["r"]
    assert refund == paid
    r = db.execute("SELECT status FROM reservations WHERE reservation_id = %s", (rid,)).fetchone()
    p = db.execute("SELECT status FROM payments WHERE reservation_id = %s", (rid,)).fetchone()
    assert r["status"] == "CANCELLED" and p["status"] == "REFUNDED"

    # The freed period can now be booked by another user
    book(db, RAHUL, VEH["rahul_car"], s, local(3, 10), local(3, 12))

    # Cancelling twice is refused
    with pytest.raises(errors.RaiseException) as ex, db.transaction():
        db.execute("SELECT fn_cancel_reservation(%s, %s)", (rid, ROHAN))
    assert hint_of(ex) == "CANNOT_CANCEL"


# --------------------------------------------------------------------------
# T20 Foreign-key and integrity constraint violations
# --------------------------------------------------------------------------
def test_T20_integrity_constraints(db):
    s = slot_id(db, 1, "A05")
    cases = [
        # (SQL, params, expected exception class)
        ("INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, hold_expires_at) "
         "VALUES (9999, 1, %s, now() + interval '1 day', now() + interval '1 day 2 hours', now())",
         (s,), errors.RaiseException),                                   # owner check trigger (user 9999 doesn't own vehicle 1)
        ("INSERT INTO vehicles (user_id, registration_no, model_name) VALUES (9999, 'TN01AA1111', 'X')",
         None, errors.ForeignKeyViolation),                               # FK -> users
        ("INSERT INTO parking_slots (location_id, slot_code) VALUES (9999, 'Z1')",
         None, errors.ForeignKeyViolation),                               # FK -> locations
        ("INSERT INTO users (full_name, email, phone, password_hash) VALUES ('Dup', 'rohan.sharma@example.in', '9000000000', 'x')",
         None, errors.UniqueViolation),                                   # UNIQUE email
        ("INSERT INTO users (full_name, email, phone, password_hash) VALUES ('Bad', 'bad@example.in', '12345', 'x')",
         None, errors.CheckViolation),                                    # CHECK phone format
        ("INSERT INTO vehicles (user_id, registration_no, model_name, is_ev) VALUES (2, 'TN01AB2222', 'EV no plug', TRUE)",
         None, errors.CheckViolation),                                    # EV must have connector
        ("INSERT INTO chargers (slot_id, charger_type, connector_type, power_kw) VALUES (%s, 'AC', 'CCS2', 150)",
         (slot_id(db, 1, "E01"),), errors.CheckViolation),                # AC charger cannot be 150 kW CCS2
        ("INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, hold_expires_at) "
         "VALUES (2, 2, %s, now() + interval '2 days', now() + interval '1 day', now())",
         (s,), errors.DataException),      # end before start: rejected while building booking_period (range lower > upper)
        ("DELETE FROM locations WHERE location_id = 1", None, errors.RestrictViolation),    # ON DELETE RESTRICT
        ("UPDATE reservations SET status = 'FLYING' WHERE reservation_id = 1", None, errors.CheckViolation),
        ("INSERT INTO booking_policy (policy_id) VALUES (2)", None, errors.CheckViolation),  # single-row table
    ]
    for sql, params, exc in cases:
        with pytest.raises(exc):
            with db.transaction():
                db.execute(sql, params)

    # The EXCLUDE constraint itself (bypassing the booking function entirely):
    with db.transaction():
        db.execute("""INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, hold_expires_at)
                      VALUES (2, 2, %s, %s, %s, now() + interval '10 minutes')""", (s, local(4, 10), local(4, 12)))
    with pytest.raises(errors.ExclusionViolation):
        with db.transaction():
            db.execute("""INSERT INTO reservations (user_id, vehicle_id, slot_id, start_time, end_time, hold_expires_at)
                          VALUES (4, 4, %s, %s, %s, now() + interval '10 minutes')""", (s, local(4, 11), local(4, 13)))


def test_invalid_booking_inputs(db):
    s = slot_id(db, 1, "A05")
    bad = [
        (ROHAN, VEH["rohan_car"], s, local(-1, 10), local(-1, 12), "INVALID_TIME"),      # in the past
        (ROHAN, VEH["rohan_car"], s, local(2, 10), local(2, 10, 15), "INVALID_TIME"),    # too short
        (ROHAN, VEH["rohan_car"], s, local(45, 10), local(45, 12), "INVALID_TIME"),      # too far ahead
        (ROHAN, VEH["rahul_car"], s, local(2, 10), local(2, 12), "VEHICLE_NOT_OWNED"),
        (ROHAN, VEH["rohan_car"], slot_id(db, 1, "E01"), local(2, 10), local(2, 12), "VEHICLE_INCOMPATIBLE"),  # petrol car in EV slot
        (ARJUN, VEH["arjun_ev"], slot_id(db, 1, "A01"), local(2, 10), local(2, 12), "VEHICLE_INCOMPATIBLE"),   # SUV in CAR slot
        (DEMO_A, VEH["demo_a_ev"], 99999, local(2, 10), local(2, 12), "SLOT_NOT_FOUND"),
    ]
    for u, v, sl, st, en, code in bad:
        with pytest.raises(errors.RaiseException) as ex:
            book(db, u, v, sl, st, en)
        assert hint_of(ex) == code, (u, v, sl, code)


def test_vehicle_with_bookings_cannot_be_deleted(client, db):
    client.post("/login", data={"email": "rohan.sharma@example.in", "password": "Password@123"})
    resp = client.post(f"/vehicles/{VEH['rohan_ev']}/delete", follow_redirects=True)
    assert resp.status_code == 200 and b"ON DELETE RESTRICT" in resp.data
    assert db.execute("SELECT 1 FROM vehicles WHERE vehicle_id = %s", (VEH["rohan_ev"],)).fetchone()


def test_quick_demo_login(client, monkeypatch):
    page = client.get("/login")
    assert b"Quick demo login" in page.data and b"arjun.mehta@example.in" in page.data
    # Clicking a card posts that account's email + password
    resp = client.post("/login", data={"email": "arjun.mehta@example.in", "password": "Password@123"})
    assert resp.status_code == 302 and resp.location.endswith("/dashboard")
    # Can be switched off
    client.post("/logout")
    monkeypatch.setenv("DEMO_LOGINS", "0")
    assert b"Quick demo login" not in client.get("/login").data
