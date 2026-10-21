"""Browsing locations and searching for available slots."""
from flask import Blueprint, jsonify, render_template, request

from config.database import AppError, query_all
from routes.guards import current_user_id, login_required
from services import booking_service, pricing_service, timeutil

bp = Blueprint("parking", __name__)


def _int_or_none(value):
    try:
        return int(value) if value not in (None, "") else None
    except ValueError:
        raise AppError("INVALID_INPUT", f"Expected a number, got {value!r}")


def _locations_with_counts():
    return query_all(
        """SELECT l.*,
                  count(s.slot_id) FILTER (WHERE s.is_active)                              AS total_slots,
                  count(s.slot_id) FILTER (WHERE s.is_active AND s.slot_type = 'EV')       AS ev_slots,
                  count(s.slot_id) FILTER (WHERE s.is_active AND s.occupancy_status = 'FREE') AS free_now,
                  count(c.charger_id) FILTER (WHERE c.status = 'OPERATIONAL' AND c.charger_type = 'AC') AS ac_ok,
                  count(c.charger_id) FILTER (WHERE c.status = 'OPERATIONAL' AND c.charger_type = 'DC') AS dc_ok,
                  count(c.charger_id) FILTER (WHERE c.status = 'FAULTY')                   AS faulty
             FROM locations l
             LEFT JOIN parking_slots s ON s.location_id = l.location_id
             LEFT JOIN chargers c      ON c.slot_id = s.slot_id
            WHERE l.is_active
            GROUP BY l.location_id
            ORDER BY l.city, l.name"""
    )


@bp.route("/locations")
def locations():
    city = request.args.get("city") or ""
    rows = _locations_with_counts()
    cities = sorted({r["city"] for r in rows})
    if city:
        rows = [r for r in rows if r["city"].lower() == city.lower()]
    return render_template("locations.html", locations=rows, cities=cities, city=city)


@bp.route("/slots")
@login_required
def slots():
    start, end = timeutil.default_window()
    vehicles = query_all("SELECT * FROM vehicles WHERE user_id = %s ORDER BY vehicle_id", (current_user_id(),))
    return render_template(
        "slots.html",
        locations=query_all("SELECT location_id, name, city FROM locations WHERE is_active ORDER BY city, name"),
        vehicles=vehicles,
        preset={
            "location_id": request.args.get("location_id", ""),
            "slot_type": request.args.get("slot_type", ""),
            "charger_type": request.args.get("charger_type", ""),
            "start": request.args.get("start") or timeutil.to_input(start),
            "end": request.args.get("end") or timeutil.to_input(end),
        },
    )


# ---------------------------------------------------------------------------
# JSON API
# ---------------------------------------------------------------------------

@bp.route("/api/locations")
def api_locations():
    return jsonify({"ok": True, "locations": _locations_with_counts()})


@bp.route("/api/slots/search")
@login_required
def api_search():
    args = request.args
    start, end = timeutil.parse_window(args.get("start"), args.get("end"))
    slot_type = args.get("slot_type") or None
    charger_type = args.get("charger_type") or None
    if slot_type not in (None, "REGULAR", "EV") or charger_type not in (None, "AC", "DC"):
        raise AppError("INVALID_INPUT", "Unknown slot or charger type")
    vehicle_id = _int_or_none(args.get("vehicle_id"))
    if vehicle_id is not None:
        owned = query_all("SELECT 1 FROM vehicles WHERE vehicle_id = %s AND user_id = %s",
                          (vehicle_id, current_user_id()))
        if not owned:
            raise AppError("VEHICLE_NOT_OWNED", "This vehicle is not registered to your account")
    rows = booking_service.search_slots(start, end, _int_or_none(args.get("location_id")),
                                        args.get("city"), slot_type, charger_type, vehicle_id)
    return jsonify({"ok": True, "count": len(rows), "start": start.isoformat(), "end": end.isoformat(),
                    "slots": rows})


@bp.route("/api/price-quote")
@login_required
def api_price_quote():
    start, end = timeutil.parse_window(request.args.get("start"), request.args.get("end"))
    slot_id = _int_or_none(request.args.get("slot_id"))
    if slot_id is None:
        raise AppError("INVALID_INPUT", "slot_id is required")
    return jsonify({"ok": True, "quote": pricing_service.quote_for_slot(slot_id, start, end)})
