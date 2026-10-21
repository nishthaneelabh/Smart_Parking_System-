"""Pricing — a thin wrapper around the PostgreSQL function fn_calculate_price.

The price is ALWAYS computed by the database. Nothing the browser sends is
used as a price.
"""
from config.database import db_errors, query_all, query_one, transaction, AppError


def quote(location_id, slot_type, charger_type, start, end):
    with db_errors():
        return query_one(
            "SELECT * FROM fn_calculate_price(%s, %s, %s, %s, %s)",
            (location_id, slot_type, charger_type, start, end),
        )


def quote_for_slot(slot_id, start, end):
    with db_errors():
        row = query_one(
            """SELECT s.location_id, s.slot_type, c.charger_type
                 FROM parking_slots s LEFT JOIN chargers c ON c.slot_id = s.slot_id
                WHERE s.slot_id = %s""",
            (slot_id,),
        )
        if not row:
            raise AppError("SLOT_NOT_FOUND", "Slot not found", 404)
        return quote(row["location_id"], row["slot_type"], row["charger_type"], start, end)


def list_rules():
    return query_all(
        """SELECT pr.*, coalesce(l.name, 'All locations (default)') AS location_name
             FROM pricing_rules pr LEFT JOIN locations l ON l.location_id = pr.location_id
            ORDER BY pr.location_id NULLS FIRST, pr.applies_to"""
    )


def list_peak_hours():
    return query_all("SELECT * FROM peak_hours ORDER BY start_time")


def get_policy():
    return query_one("SELECT * FROM booking_policy WHERE policy_id = 1")


def update_rate(rule_id, rate):
    try:
        rate = round(float(rate), 2)
    except (TypeError, ValueError):
        raise AppError("INVALID_INPUT", "Rate must be a number")
    if rate < 0:
        raise AppError("INVALID_INPUT", "Rate cannot be negative")
    with db_errors(), transaction() as cur:
        cur.execute("UPDATE pricing_rules SET rate_per_hour = %s WHERE rule_id = %s", (rate, rule_id))
        if cur.rowcount == 0:
            raise AppError("NOT_FOUND", "Pricing rule not found", 404)


def update_peak_multiplier(peak_id, multiplier):
    try:
        multiplier = round(float(multiplier), 2)
    except (TypeError, ValueError):
        raise AppError("INVALID_INPUT", "Multiplier must be a number")
    with db_errors(), transaction() as cur:
        cur.execute("UPDATE peak_hours SET multiplier = %s WHERE peak_id = %s", (multiplier, peak_id))
        if cur.rowcount == 0:
            raise AppError("NOT_FOUND", "Peak window not found", 404)
