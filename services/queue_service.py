"""Priority waiting list — wrappers around fn_join_waiting_list and
fn_process_waiting_list. The queue ordering and slot allocation happen in
PostgreSQL (see database/functions.sql, SECTION E)."""
from config.database import db_errors, query_all, query_one, transaction, AppError


def join(user_id, vehicle_id, location_id, slot_type, charger_type, start, end):
    if slot_type not in ("REGULAR", "EV"):
        raise AppError("INVALID_INPUT", "Slot type must be REGULAR or EV")
    if charger_type not in (None, "", "AC", "DC"):
        raise AppError("INVALID_INPUT", "Charger type must be AC, DC or empty")
    with db_errors(), transaction() as cur:
        cur.execute(
            "SELECT fn_join_waiting_list(%s, %s, %s, %s, %s, %s, %s) AS entry_id",
            (user_id, vehicle_id, location_id, slot_type, charger_type or None, start, end),
        )
        entry_id = cur.fetchone()["entry_id"]
        # A slot might have been freed a moment ago — try to serve the queue now.
        cur.execute("SELECT fn_process_waiting_list() AS offers")
        return entry_id


def leave(entry_id, user_id, is_admin=False):
    """Leave the queue. If an offer is pending, cancelling the offered
    reservation also closes the entry (trigger trg_res_waitlist_sync)."""
    with db_errors(), transaction() as cur:
        cur.execute(
            "SELECT * FROM waiting_list WHERE entry_id = %s FOR UPDATE", (entry_id,)
        )
        entry = cur.fetchone()
        if not entry or (entry["user_id"] != user_id and not is_admin):
            raise AppError("NOT_FOUND", "Waiting-list entry not found", 404)
        if entry["status"] == "WAITING":
            cur.execute("UPDATE waiting_list SET status = 'CANCELLED' WHERE entry_id = %s", (entry_id,))
        elif entry["status"] == "OFFERED":
            cur.execute(
                "SELECT fn_cancel_reservation(%s, %s, %s, 'Waiting-list offer declined')",
                (entry["offered_reservation_id"], user_id, is_admin),
            )
        else:
            raise AppError("INVALID_STATE", f"This entry is already {entry['status']}")


def process():
    with db_errors(), transaction() as cur:
        cur.execute("SELECT fn_process_waiting_list() AS offers")
        return cur.fetchone()["offers"]


def user_entries(user_id):
    return query_all(
        "SELECT * FROM v_waiting_queue WHERE user_id = %s ORDER BY requested_at DESC", (user_id,)
    )


def all_entries(status=None):
    if status:
        return query_all(
            """SELECT * FROM v_waiting_queue WHERE status = %s
                ORDER BY priority DESC, requested_at, entry_id""",
            (status,),
        )
    return query_all(
        """SELECT * FROM v_waiting_queue
            ORDER BY (status = 'WAITING') DESC, priority DESC, requested_at, entry_id"""
    )


def pending_offers(user_id):
    return query_all(
        """SELECT * FROM v_waiting_queue
            WHERE user_id = %s AND status = 'OFFERED' AND offer_expires_at > now()""",
        (user_id,),
    )


def count_waiting():
    return query_one("SELECT count(*) AS n FROM waiting_list WHERE status = 'WAITING'")["n"]
