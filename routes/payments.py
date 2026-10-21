"""Simulated payment gateway. No real money is charged."""
from flask import Blueprint, flash, redirect, render_template, request, url_for

from config.database import AppError, query_all
from routes.guards import current_user_id, is_admin, login_required
from services import booking_service, timeutil

bp = Blueprint("payments", __name__)

METHODS = ("UPI", "CARD", "NETBANKING", "WALLET")


@bp.route("/reservations/<int:reservation_id>/pay", methods=["GET", "POST"])
@login_required
def pay(reservation_id):
    res = booking_service.get_reservation(reservation_id, None if is_admin() else current_user_id())
    bill = booking_service.get_bill(reservation_id)

    if request.method == "POST":
        method = request.form.get("method")
        if method not in METHODS:
            flash("Please choose a payment method.", "danger")
            return redirect(url_for("payments.pay", reservation_id=reservation_id))
        fail = request.form.get("simulate_failure") == "on"
        try:
            booking_service.make_payment(reservation_id, current_user_id(), method, is_admin(), fail)
            if fail:
                flash("Payment FAILED (simulated). Your hold is still active — you can try again.", "warning")
                return redirect(url_for("payments.pay", reservation_id=reservation_id))
            flash("Payment successful! Your reservation is confirmed." if res["status"] == "HELD"
                  else "Payment successful! Your balance is cleared.", "success")
        except AppError as err:
            flash(err.message, "danger")
        return redirect(url_for("reservations.detail", reservation_id=reservation_id))

    if res["status"] == "HELD":
        amount = res["parking_fee"] + res["charging_fee"]
    elif res["status"] == "COMPLETED" and bill["balance_due"] > 0:
        amount = bill["balance_due"]
    else:
        flash("Nothing to pay for this reservation.", "info")
        return redirect(url_for("reservations.detail", reservation_id=reservation_id))
    return render_template("payment.html", r=res, amount=amount, methods=METHODS, now=timeutil.now_ist())


@bp.route("/my-payments")
@login_required
def my_payments():
    rows = query_all(
        """SELECT p.*, r.slot_id, d.location_name, d.slot_code
             FROM payments p
             JOIN reservations r ON r.reservation_id = p.reservation_id
             JOIN v_reservation_details d ON d.reservation_id = r.reservation_id
            WHERE r.user_id = %s ORDER BY p.paid_at DESC""",
        (current_user_id(),),
    )
    return render_template("my_payments.html", payments=rows)
