"""Creating, viewing, cancelling, checking in and checking out reservations."""
from flask import Blueprint, flash, jsonify, redirect, render_template, request, url_for

from config.database import AppError
from routes.guards import current_user_id, is_admin, login_required, safe_next
from services import booking_service, timeutil

bp = Blueprint("reservations", __name__)


@bp.route("/api/reservations", methods=["POST"])
@login_required
def api_create():
    """Body: {"slot_id": 8, "vehicle_id": 1, "start": "2026-10-22T12:00", "end": "2026-10-22T14:00"}
    Prices are NOT accepted from the client — the database calculates them."""
    data = request.get_json(silent=True) or request.form
    try:
        slot_id = int(data.get("slot_id"))
        vehicle_id = int(data.get("vehicle_id"))
    except (TypeError, ValueError):
        raise AppError("INVALID_INPUT", "Please choose a slot and a vehicle")
    start, end = timeutil.parse_window(data.get("start"), data.get("end"))

    reservation_id = booking_service.create_reservation(current_user_id(), vehicle_id, slot_id, start, end)
    res = booking_service.get_reservation(reservation_id)
    return jsonify({
        "ok": True,
        "reservation_id": reservation_id,
        "status": res["status"],
        "total_amount": res["total_amount"],
        "hold_expires_at": res["hold_expires_at"].isoformat(),
        "redirect": url_for("reservations.detail", reservation_id=reservation_id),
    }), 201


@bp.route("/reservations/<int:reservation_id>")
@login_required
def detail(reservation_id):
    res = booking_service.get_reservation(reservation_id, None if is_admin() else current_user_id())
    return render_template(
        "reservation.html", r=res,
        bill=booking_service.get_bill(reservation_id),
        payments=booking_service.get_payments(reservation_id),
        now=timeutil.now_ist(),
    )


@bp.route("/my-bookings")
@login_required
def my_bookings():
    rows = booking_service.user_reservations(current_user_id())
    groups = {
        "active": [r for r in rows if r["status"] in ("HELD", "CONFIRMED", "CHECKED_IN")],
        "history": [r for r in rows if r["status"] not in ("HELD", "CONFIRMED", "CHECKED_IN")],
    }
    groups["active"].sort(key=lambda r: r["start_time"])
    return render_template("my_bookings.html", groups=groups)


def _action(fn, success_msg, reservation_id):
    try:
        result = fn()
        flash(success_msg(result), "success")
    except AppError as err:
        flash(err.message, "danger")
    return redirect(safe_next(request.form.get("next")) or url_for("reservations.detail", reservation_id=reservation_id))


@bp.route("/reservations/<int:reservation_id>/cancel", methods=["POST"])
@login_required
def cancel(reservation_id):
    return _action(
        lambda: booking_service.cancel_reservation(reservation_id, current_user_id(), is_admin(),
                                                   request.form.get("reason")),
        lambda refund: f"Reservation cancelled. Refund: ₹{refund:,.2f}" if refund else "Reservation cancelled.",
        reservation_id,
    )


@bp.route("/reservations/<int:reservation_id>/check-in", methods=["POST"])
@login_required
def check_in(reservation_id):
    return _action(
        lambda: booking_service.check_in(reservation_id, current_user_id(), is_admin()),
        lambda t: f"Checked in at {timeutil.fmt(t, '%I:%M %p')}. The slot is now marked OCCUPIED.",
        reservation_id,
    )


@bp.route("/reservations/<int:reservation_id>/check-out", methods=["POST"])
@login_required
def check_out(reservation_id):
    checkout_time = None
    if is_admin() and request.form.get("checkout_time"):
        checkout_time = timeutil.parse_local(request.form["checkout_time"], "check-out time")

    def msg(bill):
        text = f"Checked out. Total ₹{bill['total_amount']:,.2f}."
        if bill["overstay_fine"] > 0:
            text += (f" Overstay of {bill['overstay_minutes']} min → fine ₹{bill['overstay_fine']:,.2f}."
                     f" Balance due ₹{bill['balance_due']:,.2f}.")
        return text

    return _action(
        lambda: booking_service.check_out(reservation_id, current_user_id(), is_admin(), checkout_time),
        msg, reservation_id,
    )
