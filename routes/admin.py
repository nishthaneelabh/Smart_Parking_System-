"""Admin dashboard. Every route is protected by @admin_required (server side)."""
from datetime import timedelta

from flask import Blueprint, flash, jsonify, redirect, render_template, request, url_for

from config.database import AppError, db_errors, query_all, query_one, transaction
from routes.guards import admin_required, current_user_id, safe_next
from services import booking_service, pricing_service, queue_service, timeutil

bp = Blueprint("admin", __name__, url_prefix="/admin")


def _back(default_endpoint, **kwargs):
    return redirect(safe_next(request.form.get("next")) or url_for(default_endpoint, **kwargs))


def _run(fn, ok_message):
    try:
        result = fn()
        flash(ok_message(result) if callable(ok_message) else ok_message, "success")
    except AppError as err:
        flash(err.message, "danger")


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
@bp.route("/")
@admin_required
def dashboard():
    stats = query_one(
        """SELECT
             (SELECT count(*) FROM locations WHERE is_active)                               AS locations,
             (SELECT count(*) FROM parking_slots WHERE is_active)                           AS slots,
             (SELECT count(*) FROM parking_slots WHERE occupancy_status = 'OCCUPIED')       AS occupied_now,
             (SELECT count(*) FROM chargers)                                                AS chargers,
             (SELECT count(*) FROM chargers WHERE status = 'FAULTY')                        AS faulty_chargers,
             (SELECT count(*) FROM reservations WHERE status = 'HELD')                      AS held,
             (SELECT count(*) FROM reservations WHERE status = 'CONFIRMED')                 AS confirmed,
             (SELECT count(*) FROM reservations WHERE status = 'CHECKED_IN')                AS checked_in,
             (SELECT count(*) FROM reservations WHERE created_at >= date_trunc('day', now())) AS booked_today,
             (SELECT count(*) FROM waiting_list WHERE status = 'WAITING')                   AS waiting,
             (SELECT coalesce(sum(amount), 0) FROM payments WHERE status = 'SUCCESS')       AS revenue,
             (SELECT coalesce(sum(overstay_fine), 0) FROM reservations)                     AS fines,
             (SELECT count(*) FROM users WHERE role = 'USER')                               AS users"""
    )
    by_status = query_all("SELECT status, count(*) AS n FROM reservations GROUP BY status ORDER BY n DESC")
    by_location = query_all(
        """SELECT l.name, l.city,
                  count(s.slot_id) AS slots,
                  count(s.slot_id) FILTER (WHERE s.occupancy_status = 'OCCUPIED') AS occupied,
                  (SELECT count(*) FROM reservations r JOIN parking_slots s2 ON s2.slot_id = r.slot_id
                    WHERE s2.location_id = l.location_id AND r.status IN ('HELD','CONFIRMED')) AS upcoming,
                  (SELECT coalesce(sum(p.amount), 0) FROM payments p
                     JOIN reservations r ON r.reservation_id = p.reservation_id
                     JOIN parking_slots s3 ON s3.slot_id = r.slot_id
                    WHERE s3.location_id = l.location_id AND p.status = 'SUCCESS') AS revenue
             FROM locations l LEFT JOIN parking_slots s ON s.location_id = l.location_id AND s.is_active
            GROUP BY l.location_id ORDER BY l.city, l.name"""
    )
    recent = query_all("SELECT * FROM audit_logs ORDER BY log_id DESC LIMIT 12")
    return render_template("admin_dashboard.html", stats=stats, by_status=by_status,
                           by_location=by_location, recent=recent)


@bp.route("/jobs/run", methods=["POST"])
@admin_required
def run_jobs():
    _run(booking_service.run_expiry_jobs,
         lambda r: (f"Scheduled jobs ran: {r['expired_holds']} hold(s) expired, {r['no_shows']} no-show(s), "
                    f"{r['expired_waits']} waiting entr(ies) expired, {r['offers_made']} waiting-list offer(s) made."))
    return _back("admin.dashboard")


# ---------------------------------------------------------------------------
# Locations
# ---------------------------------------------------------------------------
@bp.route("/locations", methods=["GET", "POST"])
@admin_required
def locations():
    if request.method == "POST":
        f = request.form

        def add():
            name, address, city = (f.get(k, "").strip() for k in ("name", "address", "city"))
            if not (name and address and city):
                raise AppError("INVALID_INPUT", "Name, address and city are required")
            lat = f.get("latitude") or None
            lon = f.get("longitude") or None
            with db_errors(), transaction() as cur:
                cur.execute(
                    """INSERT INTO locations (name, address, city, pincode, latitude, longitude)
                       VALUES (%s, %s, %s, %s, %s, %s)""",
                    (name, address, city, f.get("pincode", "").strip(), lat, lon),
                )
        _run(add, "Location added.")
        return redirect(url_for("admin.locations"))
    rows = query_all(
        """SELECT l.*, count(s.slot_id) AS slots
             FROM locations l LEFT JOIN parking_slots s ON s.location_id = l.location_id
            GROUP BY l.location_id ORDER BY l.location_id"""
    )
    return render_template("admin/locations.html", locations=rows)


@bp.route("/locations/<int:location_id>/toggle", methods=["POST"])
@admin_required
def toggle_location(location_id):
    def toggle():
        with db_errors(), transaction() as cur:
            cur.execute("UPDATE locations SET is_active = NOT is_active WHERE location_id = %s RETURNING is_active",
                        (location_id,))
            row = cur.fetchone()
            if not row:
                raise AppError("NOT_FOUND", "Location not found", 404)
            return row["is_active"]
    _run(toggle, lambda active: "Location re-opened." if active else "Location closed for new bookings.")
    return redirect(url_for("admin.locations"))


# ---------------------------------------------------------------------------
# Slots (+ charger when the slot is EV)
# ---------------------------------------------------------------------------
@bp.route("/slots", methods=["GET", "POST"])
@admin_required
def slots():
    if request.method == "POST":
        f = request.form

        def add():
            slot_type = f.get("slot_type")
            code = (f.get("slot_code") or "").strip().upper()
            if not code:
                raise AppError("INVALID_INPUT", "Slot code is required")
            with db_errors(), transaction() as cur:          # slot + charger in ONE transaction
                cur.execute(
                    """INSERT INTO parking_slots (location_id, slot_code, floor_level, slot_type, size_class)
                       VALUES (%s, %s, %s, %s, %s) RETURNING slot_id""",
                    (f.get("location_id"), code, f.get("floor_level") or 0, slot_type, f.get("size_class")),
                )
                slot_id = cur.fetchone()["slot_id"]
                if slot_type == "EV":
                    cur.execute(
                        """INSERT INTO chargers (slot_id, charger_type, connector_type, power_kw)
                           VALUES (%s, %s, %s, %s)""",
                        (slot_id, f.get("charger_type"), f.get("connector_type"), f.get("power_kw")),
                    )
            return code
        _run(add, lambda code: f"Slot {code} added.")
        return redirect(url_for("admin.slots", location_id=f.get("location_id")))

    loc = request.args.get("location_id", type=int)
    rows = query_all(
        """SELECT * FROM v_slot_overview WHERE (%(loc)s::int IS NULL OR location_id = %(loc)s)
            ORDER BY location_id, slot_type DESC, slot_code""",
        {"loc": loc},
    )
    return render_template("admin/slots.html", slots=rows, location_id=loc,
                           locations=query_all("SELECT location_id, name, city FROM locations ORDER BY location_id"))


@bp.route("/slots/<int:slot_id>/toggle", methods=["POST"])
@admin_required
def toggle_slot(slot_id):
    def toggle():
        with db_errors(), transaction() as cur:
            cur.execute("UPDATE parking_slots SET is_active = NOT is_active WHERE slot_id = %s RETURNING is_active",
                        (slot_id,))
            row = cur.fetchone()
            if not row:
                raise AppError("NOT_FOUND", "Slot not found", 404)
            return row["is_active"]
    _run(toggle, lambda active: "Slot re-opened for bookings." if active else
         "Slot closed for NEW bookings (existing bookings are kept).")
    return _back("admin.slots")


# ---------------------------------------------------------------------------
# Chargers
# ---------------------------------------------------------------------------
@bp.route("/chargers")
@admin_required
def chargers():
    rows = query_all(
        """SELECT c.*, s.slot_code, l.name AS location_name, l.city,
                  m.issue_description AS open_issue, m.reported_at AS fault_since,
                  (SELECT count(*) FROM reservations r WHERE r.slot_id = c.slot_id
                     AND r.status IN ('HELD','CONFIRMED') AND r.end_time > now()) AS upcoming
             FROM chargers c
             JOIN parking_slots s ON s.slot_id = c.slot_id
             JOIN locations l     ON l.location_id = s.location_id
             LEFT JOIN charger_maintenance m ON m.charger_id = c.charger_id AND m.resolved_at IS NULL
            ORDER BY (c.status = 'FAULTY') DESC, l.location_id, s.slot_code"""
    )
    tickets = query_all(
        """SELECT m.*, s.slot_code, l.name AS location_name, u.full_name AS reporter
             FROM charger_maintenance m
             JOIN chargers c ON c.charger_id = m.charger_id
             JOIN parking_slots s ON s.slot_id = c.slot_id
             JOIN locations l ON l.location_id = s.location_id
             LEFT JOIN users u ON u.user_id = m.reported_by
            ORDER BY m.reported_at DESC LIMIT 50"""
    )
    return render_template("admin/chargers.html", chargers=rows, tickets=tickets)


@bp.route("/chargers/<int:charger_id>/faulty", methods=["POST"])
@admin_required
def mark_faulty(charger_id):
    def go():
        with db_errors(), transaction() as cur:
            cur.execute(
                """SELECT count(*) AS n FROM reservations r JOIN chargers c ON c.slot_id = r.slot_id
                    WHERE c.charger_id = %s AND r.status IN ('HELD','CONFIRMED') AND r.end_time > now()""",
                (charger_id,),
            )
            affected = cur.fetchone()["n"]
            cur.execute("CALL sp_mark_charger_faulty(%s, %s, %s)",
                        (charger_id, request.form.get("issue"), current_user_id()))
            return affected
    _run(go, lambda n: f"Charger #{charger_id} marked FAULTY. {n} upcoming booking(s) were cancelled, refunded "
                       f"and moved to the front of the waiting list.")
    return redirect(url_for("admin.chargers"))


@bp.route("/chargers/<int:charger_id>/repair", methods=["POST"])
@admin_required
def mark_repaired(charger_id):
    def go():
        with db_errors(), transaction() as cur:
            cur.execute("CALL sp_mark_charger_repaired(%s, %s)", (charger_id, request.form.get("note")))
    _run(go, f"Charger #{charger_id} repaired — it can be booked again and the waiting list was processed.")
    return redirect(url_for("admin.chargers"))


# ---------------------------------------------------------------------------
# Reservations
# ---------------------------------------------------------------------------
@bp.route("/reservations")
@admin_required
def reservations():
    status = request.args.get("status") or None
    loc = request.args.get("location_id", type=int)
    return render_template(
        "admin/reservations.html",
        reservations=booking_service.all_reservations(status, loc),
        status=status, location_id=loc,
        locations=query_all("SELECT location_id, name FROM locations ORDER BY location_id"),
        now_input=timeutil.to_input(timeutil.now_ist()),
    )


# ---------------------------------------------------------------------------
# Waiting list
# ---------------------------------------------------------------------------
@bp.route("/waiting-list")
@admin_required
def waiting_list():
    return render_template("admin/waiting_list.html", entries=queue_service.all_entries(request.args.get("status")),
                           status=request.args.get("status"))


@bp.route("/waiting-list/process", methods=["POST"])
@admin_required
def process_waiting_list():
    _run(queue_service.process, lambda n: f"Waiting list processed: {n} offer(s) made.")
    return redirect(url_for("admin.waiting_list"))


# ---------------------------------------------------------------------------
# Payments, pricing, audit
# ---------------------------------------------------------------------------
@bp.route("/payments")
@admin_required
def payments():
    rows = query_all(
        """SELECT p.*, d.full_name, d.location_name, d.slot_code
             FROM payments p JOIN v_reservation_details d ON d.reservation_id = p.reservation_id
            ORDER BY p.paid_at DESC LIMIT 300"""
    )
    totals = query_one(
        """SELECT coalesce(sum(amount) FILTER (WHERE status = 'SUCCESS'), 0)  AS collected,
                  coalesce(sum(amount) FILTER (WHERE status = 'REFUNDED'), 0) AS refunded,
                  count(*) FILTER (WHERE status = 'FAILED')                   AS failed
             FROM payments"""
    )
    return render_template("admin/payments.html", payments=rows, totals=totals)


@bp.route("/pricing", methods=["GET", "POST"])
@admin_required
def pricing():
    if request.method == "POST":
        if request.form.get("rule_id"):
            _run(lambda: pricing_service.update_rate(request.form["rule_id"], request.form.get("rate")),
                 "Rate updated. New bookings use it immediately.")
        elif request.form.get("peak_id"):
            _run(lambda: pricing_service.update_peak_multiplier(request.form["peak_id"], request.form.get("multiplier")),
                 "Peak multiplier updated.")
        return redirect(url_for("admin.pricing"))
    return render_template("admin/pricing.html", rules=pricing_service.list_rules(),
                           peaks=pricing_service.list_peak_hours(), policy=pricing_service.get_policy())


@bp.route("/audit")
@admin_required
def audit():
    rows = query_all("SELECT * FROM audit_logs ORDER BY log_id DESC LIMIT 300")
    return render_template("admin/audit.html", logs=rows)


# ---------------------------------------------------------------------------
# Concurrency demo — the highlight
# ---------------------------------------------------------------------------
@bp.route("/concurrency")
@admin_required
def concurrency():
    start, end = timeutil.default_window()
    slots = query_all(
        """SELECT s.slot_id, s.slot_code, s.slot_type, l.name AS location_name, c.charger_type, c.connector_type
             FROM parking_slots s JOIN locations l ON l.location_id = s.location_id
             LEFT JOIN chargers c ON c.slot_id = s.slot_id
            WHERE s.is_active AND (s.slot_type = 'REGULAR' OR (c.status = 'OPERATIONAL'
                  AND c.connector_type IN ('CCS2', 'TYPE2')))
              AND s.size_class = 'SUV'
            ORDER BY l.location_id, s.slot_code"""
    )
    return render_template("admin/concurrency.html", slots=slots,
                           start=timeutil.to_input(start + timedelta(days=1)),
                           end=timeutil.to_input(end + timedelta(days=1)))


@bp.route("/api/concurrency-demo", methods=["POST"])
@admin_required
def api_concurrency_demo():
    data = request.get_json(silent=True) or {}
    try:
        slot_id = int(data.get("slot_id"))
        hold = max(0.0, min(float(data.get("hold_seconds", 2)), 10.0))
    except (TypeError, ValueError):
        raise AppError("INVALID_INPUT", "Choose a slot")
    start, end = timeutil.parse_window(data.get("start"), data.get("end"))
    result = booking_service.run_concurrency_demo(slot_id, start, end, hold_seconds=hold,
                                                  nowait=bool(data.get("nowait")),
                                                  cleanup=bool(data.get("cleanup", True)))
    return jsonify(result)
