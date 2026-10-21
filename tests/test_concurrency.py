"""T05, T06 — real concurrency with separate PostgreSQL connections.

Every "user" here is a separate psycopg connection = a separate PostgreSQL
backend process, exactly like two people using the website at once.
"""
import threading
import time
from datetime import timedelta

import psycopg
import pytest

from config.database import translate_db_error
from services.booking_service import run_concurrency_demo
from tests.conftest import DEMO_A, DEMO_B, ROHAN, RAHUL, TEST_DSN, VEH, local, slot_id


def _race(new_conn, attempts, nowait=False, hold=0.0):
    """attempts = [(user, vehicle, slot, start, end), ...] all fired at the same instant."""
    barrier = threading.Barrier(len(attempts))
    results = [None] * len(attempts)

    def worker(i, args):
        conn = new_conn()
        barrier.wait()
        t0 = time.perf_counter()
        try:
            with conn.transaction():                        # BEGIN
                rid = conn.execute("SELECT fn_create_reservation(%s,%s,%s,%s,%s,'DIRECT',%s) AS id",
                                   (*args, nowait)).fetchone()["id"]
                if hold:
                    conn.execute("SELECT pg_sleep(%s)", (hold,))
            results[i] = ("OK", rid, time.perf_counter() - t0)    # COMMIT
        except psycopg.Error as exc:                               # ROLLBACK
            results[i] = ("ERR", translate_db_error(exc).code, time.perf_counter() - t0)

    threads = [threading.Thread(target=worker, args=(i, a)) for i, a in enumerate(attempts)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    return results


def _active_count(db, slot, start, end):
    return db.execute("""SELECT count(*) AS n FROM reservations
                          WHERE slot_id = %s AND status IN ('HELD','CONFIRMED','CHECKED_IN')
                            AND booking_period && tstzrange(%s, %s, '[)')""", (slot, start, end)).fetchone()["n"]


# --------------------------------------------------------------------------
# T05 Two users booking the same slot concurrently
# --------------------------------------------------------------------------
def test_T05_same_slot_concurrent_hold(db, new_conn):
    """Winner holds its transaction open 1.5 s; the loser must WAIT on the
    row lock and then be rejected with SLOT_UNAVAILABLE."""
    s, start, end = slot_id(db, 1, "E03"), local(2, 12), local(2, 14)
    res = _race(new_conn, [(DEMO_A, VEH["demo_a_ev"], s, start, end),
                           (DEMO_B, VEH["demo_b_ev"], s, start, end)], hold=1.5)
    oks = [r for r in res if r[0] == "OK"]
    errs = [r for r in res if r[0] == "ERR"]
    assert len(oks) == 1 and len(errs) == 1, res
    assert errs[0][1] == "SLOT_UNAVAILABLE"
    assert errs[0][2] >= 1.0, "loser should have waited for the winner's lock"
    assert _active_count(db, s, start, end) == 1


@pytest.mark.parametrize("users", [2, 6])
def test_T05_same_slot_concurrent_race_many_rounds(db, new_conn, users):
    """No artificial delay at all: N users fire at the same instant, 15 rounds."""
    s = slot_id(db, 1, "A05")       # SUV-size regular slot; every seeded vehicle type fits
    vehicles = [(ROHAN, VEH["rohan_car"]), (RAHUL, VEH["rahul_car"]), (DEMO_A, VEH["demo_a_ev"]),
                (DEMO_B, VEH["demo_b_ev"]), (3, VEH["meera_car"]), (8, VEH["vikram_suv"])][:users]
    for rnd in range(15):
        start = local(2, 6) + timedelta(hours=rnd)       # a different hour each round
        end = start + timedelta(hours=1)
        res = _race(new_conn, [(u, v, s, start, end) for u, v in vehicles])
        oks = [r for r in res if r[0] == "OK"]
        assert len(oks) == 1, f"round {rnd}: {res}"
        assert all(r[1] == "SLOT_UNAVAILABLE" for r in res if r[0] == "ERR"), res
        assert _active_count(db, s, start, end) == 1


def test_T05_nowait_fails_fast(db, new_conn):
    s, start, end = slot_id(db, 1, "E03"), local(2, 16), local(2, 18)
    res = _race(new_conn, [(DEMO_A, VEH["demo_a_ev"], s, start, end),
                           (DEMO_B, VEH["demo_b_ev"], s, start, end)], nowait=True, hold=1.0)
    codes = sorted(r[1] if r[0] == "ERR" else "OK" for r in res)
    assert codes == ["OK", "SLOT_BUSY"], res
    loser_time = [r[2] for r in res if r[0] == "ERR"][0]
    assert loser_time < 0.5, "NOWAIT must fail immediately instead of waiting"
    assert _active_count(db, s, start, end) == 1


def test_T05_demo_service(db):
    """The same demo the admin page runs."""
    r = run_concurrency_demo(slot_id(db, 1, "E03"), local(2, 12), local(2, 14), hold_seconds=0.5,
                             cleanup=True, dsn=TEST_DSN)
    assert r["successful_bookings"] == 1 and r["double_booking_prevented"]
    assert len({x["backend_pid"] for x in r["results"]}) == 2, "must be two different PostgreSQL backends"


# --------------------------------------------------------------------------
# T06 Booking different slots simultaneously — both must succeed
# --------------------------------------------------------------------------
def test_T06_different_slots_simultaneously(db, new_conn):
    start, end = local(2, 12), local(2, 14)
    s1, s2 = slot_id(db, 1, "E03"), slot_id(db, 1, "E02")
    t0 = time.perf_counter()
    res = _race(new_conn, [(DEMO_A, VEH["demo_a_ev"], s1, start, end),
                           (DEMO_B, VEH["demo_b_ev"], s2, start, end)], hold=1.0)
    elapsed = time.perf_counter() - t0
    assert [r[0] for r in res] == ["OK", "OK"], res
    # Row-level locks on DIFFERENT rows do not block each other: both ran in parallel (~1 s, not ~2 s)
    assert elapsed < 1.8, f"different slots should not wait for each other (took {elapsed:.2f}s)"
