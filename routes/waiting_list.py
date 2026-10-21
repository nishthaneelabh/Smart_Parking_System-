"""Priority waiting list for users."""
from flask import Blueprint, flash, jsonify, redirect, render_template, request, url_for

from config.database import AppError, query_all
from routes.guards import current_user_id, is_admin, login_required, safe_next
from services import queue_service, timeutil

bp = Blueprint("waiting_list", __name__)


def _join_from(data):
    try:
        vehicle_id = int(data.get("vehicle_id"))
        location_id = int(data.get("location_id"))
    except (TypeError, ValueError):
        raise AppError("INVALID_INPUT", "Please choose a location and a vehicle")
    start, end = timeutil.parse_window(data.get("start"), data.get("end"))
    return queue_service.join(current_user_id(), vehicle_id, location_id,
                              data.get("slot_type") or "REGULAR", data.get("charger_type") or None, start, end)


@bp.route("/waiting-list", methods=["GET", "POST"])
@login_required
def index():
    if request.method == "POST":
        try:
            entry_id = _join_from(request.form)
            flash(f"You joined the waiting list (entry #{entry_id}). We'll offer you a slot as soon as one frees up.",
                  "success")
        except AppError as err:
            flash(err.message, "danger")
        return redirect(url_for("waiting_list.index"))

    uid = current_user_id()
    start, end = timeutil.default_window()
    return render_template(
        "waiting_list.html",
        entries=queue_service.user_entries(uid),
        locations=query_all("SELECT location_id, name, city FROM locations WHERE is_active ORDER BY city, name"),
        vehicles=query_all("SELECT * FROM vehicles WHERE user_id = %s ORDER BY vehicle_id", (uid,)),
        preset={k: request.args.get(k, "") for k in ("location_id", "slot_type", "charger_type", "vehicle_id")}
        | {"start": request.args.get("start") or timeutil.to_input(start),
           "end": request.args.get("end") or timeutil.to_input(end)},
    )


@bp.route("/api/waiting-list", methods=["POST"])
@login_required
def api_join():
    entry_id = _join_from(request.get_json(silent=True) or request.form)
    return jsonify({"ok": True, "entry_id": entry_id, "redirect": url_for("waiting_list.index")}), 201


@bp.route("/waiting-list/<int:entry_id>/leave", methods=["POST"])
@login_required
def leave(entry_id):
    try:
        queue_service.leave(entry_id, current_user_id(), is_admin())
        flash("You left the waiting list.", "info")
    except AppError as err:
        flash(err.message, "danger")
    return redirect(safe_next(request.form.get("next")) or url_for("waiting_list.index"))
