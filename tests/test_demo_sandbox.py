"""Public-demo mode (services/demo_sandbox.py): every visitor gets a private copy
of the sample data, and a page refresh throws their changes away."""
import pytest

from tests.conftest import VEH, local
from services import demo_sandbox

RELOAD = {"Cache-Control": "max-age=0", "Accept": "text/html", "Sec-Fetch-Dest": "document"}
ROHAN_LOGIN = {"email": "rohan.sharma@example.in", "password": "Password@123"}


@pytest.fixture
def demo_app():
    from app import create_app
    return create_app({"TESTING": True, "WTF_CSRF_ENABLED": False, "DEMO_SANDBOX": True})


def sandbox_of(client):
    with client.session_transaction() as s:
        return s.get("sandbox")


def count(db, schema, table):
    return db.execute(f'SELECT count(*) AS n FROM "{schema}".{table}').fetchone()["n"]


def book(client, db):
    slot = db.execute("SELECT slot_id FROM parking_slots WHERE location_id = 1 AND slot_code = 'E03'").fetchone()
    start, end = local(3, 12), local(3, 14)
    resp = client.post("/api/reservations", json={
        "slot_id": slot["slot_id"], "vehicle_id": VEH["rohan_ev"],
        "start": start.strftime("%Y-%m-%dT%H:%M"), "end": end.strftime("%Y-%m-%dT%H:%M")})
    assert resp.status_code == 201, resp.json
    return resp.json["reservation_id"]


def test_D01_sandbox_is_a_full_copy_of_the_template(demo_app, db):
    client = demo_app.test_client()
    assert b"Demo mode" in client.get("/").data
    sb = sandbox_of(client)
    assert demo_sandbox.is_sandbox_name(sb)
    for table in ("users", "vehicles", "locations", "parking_slots", "chargers", "reservations",
                  "waiting_list", "payments", "pricing_rules", "peak_hours", "booking_policy"):
        assert count(db, sb, table) == count(db, "parking", table), table
    assert count(db, sb, "parking_slots") == 40

    def objects(schema):
        return db.execute(
            """SELECT (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                        WHERE c.relnamespace = %(s)s::regnamespace AND NOT t.tgisinternal) AS triggers,
                      (SELECT count(*) FROM pg_constraint WHERE connamespace = %(s)s::regnamespace) AS constraints,
                      (SELECT count(*) FROM pg_class WHERE relnamespace = %(s)s::regnamespace AND relkind = 'v') AS views""",
            {"s": schema}).fetchone()
    assert objects(sb) == objects("parking")


def test_D02_changes_survive_navigation_but_not_a_refresh(demo_app, db):
    client = demo_app.test_client()
    client.post("/login", data=ROHAN_LOGIN)
    before = count(db, "parking", "reservations")
    rid = book(client, db)
    sb = sandbox_of(client)

    # Visible on other pages, stored only in the visitor's copy
    assert f"/reservations/{rid}".encode() in client.get("/my-bookings").data
    assert count(db, sb, "reservations") == before + 1
    assert count(db, "parking", "reservations") == before, "the template must never change"

    # Refresh -> brand-new copy, old one dropped, still logged in (seed user)
    client.get("/my-bookings", headers=RELOAD)
    new_sb = sandbox_of(client)
    assert new_sb != sb
    assert count(db, new_sb, "reservations") == before
    assert db.execute("SELECT to_regnamespace(%s) AS ns", (sb,)).fetchone()["ns"] is None
    with client.session_transaction() as s:
        assert s.get("user_id") == 2


def test_D03_visitors_cannot_see_each_others_changes(demo_app, db):
    a, b = demo_app.test_client(), demo_app.test_client()
    a.post("/login", data=ROHAN_LOGIN)
    b.post("/login", data=ROHAN_LOGIN)
    book(a, db)
    assert sandbox_of(a) != sandbox_of(b)
    assert count(db, sandbox_of(a), "reservations") == count(db, sandbox_of(b), "reservations") + 1
    book(b, db)                       # same slot, same time: fine, it's B's own copy


def test_D04_reset_button_and_new_accounts(demo_app, db):
    client = demo_app.test_client()
    client.get("/")
    resp = client.post("/register", data={
        "full_name": "Test Visitor", "email": "visitor@example.in", "phone": "9123456780",
        "password": "Password@123", "confirm_password": "Password@123"})
    assert resp.status_code == 302
    client.post("/login", data={"email": "visitor@example.in", "password": "Password@123"})
    with client.session_transaction() as s:
        assert s.get("user_id")
    old = sandbox_of(client)

    resp = client.post("/demo/reset", data={"next": "/locations"})
    assert resp.status_code == 302 and resp.location.endswith("/locations")
    assert sandbox_of(client) != old
    with client.session_transaction() as s:
        assert s.get("user_id") is None, "an account created in the old copy no longer exists"
    assert db.execute("SELECT 1 FROM parking.users WHERE email = 'visitor@example.in'").fetchone() is None


def test_D05_concurrency_demo_runs_inside_the_sandbox(demo_app, db):
    client = demo_app.test_client()
    client.post("/login", data={"email": "admin@smartpark.in", "password": "Admin@123"})
    slot = db.execute("SELECT slot_id FROM parking_slots WHERE location_id = 1 AND slot_code = 'E03'").fetchone()
    start, end = local(4, 10), local(4, 12)
    before = count(db, "parking", "reservations")
    resp = client.post("/admin/api/concurrency-demo", json={
        "slot_id": slot["slot_id"], "hold_seconds": 0.3, "cleanup": False,
        "start": start.strftime("%Y-%m-%dT%H:%M"), "end": end.strftime("%Y-%m-%dT%H:%M")})
    result = resp.json
    assert resp.status_code == 200, result
    assert result["successful_bookings"] == 1 and result["double_booking_prevented"], result["results"]
    assert count(db, sandbox_of(client), "reservations") == before + 1
    assert count(db, "parking", "reservations") == before


def test_D06_idle_sandboxes_are_dropped(demo_app, db):
    old = demo_app.test_client()
    old.get("/")
    stale = sandbox_of(old)
    db.execute("UPDATE demo_sandbox.sandboxes SET last_seen = now() - interval '1 day' WHERE name = %s", (stale,))
    demo_app.test_client().get("/")                # a new visitor triggers the clean-up
    assert db.execute("SELECT to_regnamespace(%s) AS ns", (stale,)).fetchone()["ns"] is None
    old.get("/")                                    # the idle visitor just gets a fresh copy
    assert sandbox_of(old) != stale


def test_D07_normal_mode_is_unchanged(client):
    page = client.get("/")
    assert page.status_code == 200 and b"Demo mode" not in page.data
    assert sandbox_of(client) is None
