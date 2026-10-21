"""Reservations — search, safe booking, payment, cancellation, check-in/out,
plus the two-connection concurrency demonstration.

The business rules live in PostgreSQL functions (database/functions.sql).
This module decides the TRANSACTION BOUNDARIES (BEGIN/COMMIT/ROLLBACK)
and converts database errors into friendly messages.
"""
import threading
import time

import psycopg

from config.database import (AppError, connect, current_sandbox, db_errors, query_all,
                             query_one, transaction, translate_db_error)

# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def search_slots(start, end, location_id=None, city=None, slot_type=None,
                 charger_type=None, vehicle_id=None):
    """Future availability for [start, end) — see fn_search_available_slots."""
    with db_errors():
        return query_all(
            "SELECT * FROM fn_search_available_slots(%s, %s, %s, %s, %s, %s, %s)",
            (start, end, location_id, city or None, slot_type or None,
             charger_type or None, vehicle_id),
        )


# ---------------------------------------------------------------------------
# Safe booking
# ---------------------------------------------------------------------------

def create_reservation(user_id, vehicle_id, slot_id, start, end, nowait=False, conn=None):
    """
    BEGIN;
      SELECT fn_create_reservation(...);   -- locks the slot row FOR UPDATE,
                                           -- re-checks overlaps, inserts HELD
    COMMIT;                                -- or ROLLBACK on any error

    Returns the new reservation_id. Raises AppError('SLOT_UNAVAILABLE', ...)
    if somebody else already holds an overlapping reservation.
    """
    with db_errors(), transaction(conn) as cur:
        cur.execute(
            "SELECT fn_create_reservation(%s, %s, %s, %s, %s, 'DIRECT', %s) AS reservation_id",
            (user_id, vehicle_id, slot_id, start, end, nowait),
        )
        return cur.fetchone()["reservation_id"]


def make_payment(reservation_id, user_id, method, is_admin=False, simulate_failure=False):
    with db_errors(), transaction() as cur:
        cur.execute(
            "SELECT fn_make_payment(%s, %s, %s, %s, %s) AS payment_id",
            (reservation_id, user_id, method, is_admin, simulate_failure),
        )
        return cur.fetchone()["payment_id"]


def cancel_reservation(reservation_id, user_id, is_admin=False, reason=None):
    with db_errors(), transaction() as cur:
        cur.execute(
            "SELECT fn_cancel_reservation(%s, %s, %s, %s) AS refunded",
            (reservation_id, user_id, is_admin, reason or ("Cancelled by admin" if is_admin else "Cancelled by user")),
        )
        return cur.fetchone()["refunded"]


def check_in(reservation_id, user_id, is_admin=False):
    with db_errors(), transaction() as cur:
        cur.execute("SELECT fn_check_in(%s, %s, %s) AS t", (reservation_id, user_id, is_admin))
        return cur.fetchone()["t"]


def check_out(reservation_id, user_id, is_admin=False, checkout_time=None):
    with db_errors(), transaction() as cur:
        cur.execute(
            "SELECT * FROM fn_check_out(%s, %s, %s, %s)",
            (reservation_id, user_id, is_admin, checkout_time),
        )
        return cur.fetchone()


# ---------------------------------------------------------------------------
# Read helpers
# ---------------------------------------------------------------------------

def get_reservation(reservation_id, user_id=None):
    """Reservation details. When user_id is given, only that user's booking."""
    if user_id is None:
        row = query_one("SELECT * FROM v_reservation_details WHERE reservation_id = %s", (reservation_id,))
    else:
        row = query_one(
            "SELECT * FROM v_reservation_details WHERE reservation_id = %s AND user_id = %s",
            (reservation_id, user_id),
        )
    if not row:
        raise AppError("RESERVATION_NOT_FOUND", "Reservation not found", 404)
    return row


def get_bill(reservation_id):
    return query_one("SELECT * FROM fn_final_bill(%s)", (reservation_id,))


def get_payments(reservation_id):
    return query_all(
        "SELECT * FROM payments WHERE reservation_id = %s ORDER BY paid_at", (reservation_id,)
    )


def user_reservations(user_id):
    return query_all(
        "SELECT * FROM v_reservation_details WHERE user_id = %s ORDER BY start_time DESC", (user_id,)
    )


def all_reservations(status=None, location_id=None, limit=300):
    return query_all(
        """SELECT * FROM v_reservation_details
            WHERE (%(status)s::text IS NULL OR status = %(status)s)
              AND (%(loc)s::int IS NULL OR location_id = %(loc)s)
            ORDER BY start_time DESC LIMIT %(limit)s""",
        {"status": status or None, "loc": location_id, "limit": limit},
    )


def run_expiry_jobs():
    with db_errors(), transaction() as cur:
        cur.execute("SELECT * FROM fn_run_expiry_jobs()")
        return cur.fetchone()


# ---------------------------------------------------------------------------
# Concurrency demonstration (two REAL connections, two threads)
# ---------------------------------------------------------------------------

def run_concurrency_demo(slot_id, start, end, hold_seconds=2.0, nowait=False, cleanup=True,
                         dsn=None):
    """
    Two demo users try to reserve the SAME slot for the SAME time, each on
    its own PostgreSQL connection (= its own backend process), started at
    the same instant through a threading.Barrier.

    hold_seconds > 0 : whoever gets the row lock keeps its transaction open
                       for that long (pg_sleep) before COMMIT, so you can SEE
                       the other transaction waiting on the lock.
    nowait = True    : the loser does not wait; FOR UPDATE NOWAIT fails at once.

    Returns a dict with a timeline, each user's outcome and a verification
    query showing how many active reservations overlap (must be <= 1).
    """
    sandbox = current_sandbox()       # the threads below have no request context
    users = _demo_users(dsn, sandbox)
    if len(users) < 2:
        raise AppError("DEMO_USERS_MISSING", "Demo users demo.a@example.in / demo.b@example.in not found (re-run seed.sql)")

    barrier = threading.Barrier(2)
    t_zero = time.perf_counter()
    events, results = [], {}
    lock = threading.Lock()

    def log(who, msg):
        with lock:
            events.append({"t_ms": round((time.perf_counter() - t_zero) * 1000, 1), "who": who, "msg": msg})

    def worker(label, user):
        conn = connect(dsn, sandbox)
        result = {"user": user["full_name"], "label": label, "user_id": user["user_id"]}
        t0 = None
        try:
            pid = conn.execute("SELECT pg_backend_pid() AS pid").fetchone()["pid"]
            result["backend_pid"] = pid
            barrier.wait()
            log(label, f"BEGIN (PostgreSQL backend pid {pid})")
            t0 = time.perf_counter()
            with conn.transaction():
                with conn.cursor() as cur:
                    log(label, "SELECT fn_create_reservation(...) → asks for row lock on slot "
                               f"{slot_id} (FOR UPDATE{' NOWAIT' if nowait else ''})")
                    cur.execute(
                        "SELECT fn_create_reservation(%s, %s, %s, %s, %s, 'DIRECT', %s) AS id",
                        (user["user_id"], user["vehicle_id"], slot_id, start, end, nowait),
                    )
                    res_id = cur.fetchone()["id"]
                    waited = (time.perf_counter() - t0) * 1000
                    result["waited_ms"] = round(waited, 1)
                    log(label, f"Lock granted after {waited:.0f} ms → reservation #{res_id} inserted (HELD)")
                    if hold_seconds > 0:
                        log(label, f"Keeping the transaction open for {hold_seconds:g}s (pg_sleep) — other user must wait")
                        cur.execute("SELECT pg_sleep(%s)", (hold_seconds,))
            log(label, f"COMMIT ✔ reservation #{res_id} saved")
            result.update(ok=True, reservation_id=res_id)
        except psycopg.Error as exc:
            err = translate_db_error(exc)
            waited = round((time.perf_counter() - t0) * 1000, 1) if t0 else 0
            result.update(ok=False, waited_ms=waited, error_code=err.code, error=err.message)
            log(label, f"ROLLBACK ✖ {err.code}: {err.message}")
        except threading.BrokenBarrierError:
            result.update(ok=False, error_code="DEMO_ERROR", error="Barrier broken")
        finally:
            conn.close()
            results[label] = result

    threads = [threading.Thread(target=worker, args=(lbl, u)) for lbl, u in zip(("User A", "User B"), users)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    with connect(dsn, sandbox) as conn:
        overlap = conn.execute(
            """SELECT reservation_id, user_id, status, start_time, end_time
                 FROM reservations
                WHERE slot_id = %s AND status IN ('HELD','CONFIRMED','CHECKED_IN')
                  AND booking_period && tstzrange(%s, %s, '[)')""",
            (slot_id, start, end),
        ).fetchall()
        cleaned = []
        if cleanup:
            for r in results.values():
                if r.get("ok"):
                    conn.execute(
                        "SELECT fn_cancel_reservation(%s, %s, TRUE, 'Concurrency demo clean-up')",
                        (r["reservation_id"], r["user_id"]),
                    )
                    cleaned.append(r["reservation_id"])

    successes = sum(1 for r in results.values() if r.get("ok"))
    return {
        "ok": True,
        "slot_id": slot_id,
        "mode": "NOWAIT" if nowait else "FOR UPDATE (wait)",
        "hold_seconds": hold_seconds,
        "events": sorted(events, key=lambda e: e["t_ms"]),
        "results": [results.get("User A"), results.get("User B")],
        "successful_bookings": successes,
        "active_overlapping_rows": len(overlap),
        "double_booking_prevented": len(overlap) <= 1 and successes <= 1,
        "cleaned_up": cleaned,
    }


def _demo_users(dsn=None, sandbox=None):
    with connect(dsn, sandbox) as conn:
        return conn.execute(
            """SELECT u.user_id, u.full_name, min(v.vehicle_id) AS vehicle_id
                 FROM users u JOIN vehicles v ON v.user_id = u.user_id
                WHERE u.email IN ('demo.a@example.in', 'demo.b@example.in')
                GROUP BY u.user_id, u.full_name ORDER BY u.email"""
        ).fetchall()
