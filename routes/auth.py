"""Registration, login, logout, dashboard and vehicle management."""
import os
import re

from flask import Blueprint, flash, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from config.database import AppError, db_errors, query_all, query_one, transaction
from routes.guards import current_user_id, login_required
from services import booking_service, queue_service

bp = Blueprint("auth", __name__)

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
PHONE_RE = re.compile(r"^[6-9][0-9]{9}$")
PLATE_RE = re.compile(r"^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$")
CONNECTORS = ("TYPE2", "CCS2", "CHADEMO", "BHARAT_AC001")


def _clean_plate(raw):
    return re.sub(r"[\s-]", "", (raw or "").upper())


def validate_vehicle(form):
    """Server-side validation of a vehicle form. Returns a dict or raises AppError."""
    plate = _clean_plate(form.get("registration_no"))
    vtype = form.get("vehicle_type", "CAR")
    model = (form.get("model_name") or "").strip()
    is_ev = form.get("is_ev") in ("on", "true", "1", "yes")
    connector = form.get("connector_type") or None
    if not PLATE_RE.match(plate):
        raise AppError("INVALID_INPUT", "Registration number must look like TN09AB1234")
    if vtype not in ("CAR", "SUV", "BIKE"):
        raise AppError("INVALID_INPUT", "Vehicle type must be CAR, SUV or BIKE")
    if len(model) < 2:
        raise AppError("INVALID_INPUT", "Please enter the vehicle model")
    if is_ev and connector not in CONNECTORS:
        raise AppError("INVALID_INPUT", "Please choose the EV's charging connector")
    if not is_ev:
        connector = None
    return {"registration_no": plate, "vehicle_type": vtype, "model_name": model,
            "is_ev": is_ev, "connector_type": connector}


@bp.route("/")
def index():
    stats = query_one(
        """SELECT (SELECT count(*) FROM locations WHERE is_active) AS locations,
                  (SELECT count(*) FROM parking_slots WHERE is_active) AS slots,
                  (SELECT count(*) FROM chargers WHERE status = 'OPERATIONAL') AS chargers,
                  (SELECT count(DISTINCT city) FROM locations WHERE is_active) AS cities"""
    )
    return render_template("index.html", stats=stats)


@bp.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "GET":
        return render_template("register.html", form={})

    form = request.form
    name = (form.get("full_name") or "").strip()
    email = (form.get("email") or "").strip().lower()
    phone = (form.get("phone") or "").strip()
    password = form.get("password") or ""
    errors = []
    if len(name) < 2:
        errors.append("Please enter your full name.")
    if not EMAIL_RE.match(email):
        errors.append("Please enter a valid email address.")
    if not PHONE_RE.match(phone):
        errors.append("Phone must be a 10-digit Indian mobile number starting with 6–9.")
    if len(password) < 8 or not re.search(r"\d", password) or not re.search(r"[A-Za-z]", password):
        errors.append("Password must be at least 8 characters with letters and numbers.")
    if password != form.get("confirm_password"):
        errors.append("Passwords do not match.")
    vehicle = None
    if form.get("registration_no"):
        try:
            vehicle = validate_vehicle(form)
        except AppError as err:
            errors.append(err.message)
    if errors:
        for e in errors:
            flash(e, "danger")
        return render_template("register.html", form=form), 400

    try:
        with db_errors(), transaction() as cur:
            cur.execute(
                """INSERT INTO users (full_name, email, phone, password_hash)
                   VALUES (%s, %s, %s, %s) RETURNING user_id""",
                (name, email, phone, generate_password_hash(password)),
            )
            user_id = cur.fetchone()["user_id"]
            if vehicle:
                cur.execute(
                    """INSERT INTO vehicles (user_id, registration_no, vehicle_type, model_name, is_ev, connector_type)
                       VALUES (%s, %s, %s, %s, %s, %s)""",
                    (user_id, vehicle["registration_no"], vehicle["vehicle_type"], vehicle["model_name"],
                     vehicle["is_ev"], vehicle["connector_type"]),
                )
    except AppError as err:
        flash(err.message, "danger")
        return render_template("register.html", form=form), err.status

    flash("Account created! Please log in.", "success")
    return redirect(url_for("auth.login", email=email))


# Sample accounts created by database/seed.sql, offered as one-click logins.
# Turn off with DEMO_LOGINS=0 in .env (e.g. if the site were ever deployed).
DEMO_ACCOUNTS = [
    ("admin@smartpark.in",        "Admin@123",    "Manage slots, chargers, run the concurrency demo"),
    ("rohan.sharma@example.in",   "Password@123", "Premium · Nexon EV + Honda City · has bookings"),
    ("arjun.mehta@example.in",    "Password@123", "Accessibility permit · top of the waiting list"),
    ("meera.pillai@example.in",   "Password@123", "Has a paid overstay fine · waiting for DC charger"),
    ("vikram.singh@example.in",   "Password@123", "Premium · Fortuner SUV · unpaid overstay fine"),
    ("divya.krishnan@example.in", "Password@123", "Has an active 10-minute hold to pay"),
    ("rahul.verma@example.in",    "Password@123", "Currently checked in (slot occupied)"),
    ("demo.a@example.in",         "Password@123", "Clean account with an EV — try booking"),
    ("demo.b@example.in",         "Password@123", "Second clean EV account — race Demo A"),
]


def demo_logins_enabled():
    return os.environ.get("DEMO_LOGINS", "1") == "1"


def demo_accounts():
    """Sample accounts that actually exist in the database right now."""
    if not demo_logins_enabled():
        return []
    emails = [a[0] for a in DEMO_ACCOUNTS]
    rows = {r["email"]: r for r in query_all(
        "SELECT email, full_name, role, membership_tier, has_accessibility_permit FROM users WHERE email = ANY(%s)",
        (emails,))}
    return [dict(rows[e], password=pw, note=note) for e, pw, note in DEMO_ACCOUNTS if e in rows]


@bp.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        return render_template("login.html", email=request.args.get("email", ""), demo_accounts=demo_accounts())

    email = (request.form.get("email") or "").strip().lower()
    password = request.form.get("password") or ""
    user = query_one("SELECT user_id, full_name, password_hash, role FROM users WHERE email = %s", (email,))
    if not user or not check_password_hash(user["password_hash"], password):
        flash("Invalid email or password.", "danger")
        return render_template("login.html", email=email, demo_accounts=demo_accounts()), 401

    csrf, sandbox = session.get("csrf_token"), session.get("sandbox")
    session.clear()                         # prevent session fixation
    session.permanent = True
    session.update(user_id=user["user_id"], name=user["full_name"], role=user["role"])
    if csrf:
        session["csrf_token"] = csrf
    if sandbox:                             # demo mode: keep this visitor's data copy
        session["sandbox"] = sandbox
    flash(f"Welcome back, {user['full_name'].split()[0]}!", "success")

    nxt = request.args.get("next") or ""
    if nxt.startswith("/") and not nxt.startswith("//"):
        return redirect(nxt)
    return redirect(url_for("admin.dashboard" if user["role"] == "ADMIN" else "auth.dashboard"))


@bp.route("/logout", methods=["POST"])
def logout():
    sandbox = session.get("sandbox")
    session.clear()
    if sandbox:
        session["sandbox"] = sandbox
    flash("You have been logged out.", "info")
    return redirect(url_for("auth.index"))


@bp.route("/dashboard")
@login_required
def dashboard():
    uid = current_user_id()
    reservations = booking_service.user_reservations(uid)
    active = [r for r in reservations if r["status"] in ("HELD", "CONFIRMED", "CHECKED_IN")]
    active.sort(key=lambda r: r["start_time"])
    stats = query_one(
        """SELECT count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
                  count(*) FILTER (WHERE status IN ('HELD','CONFIRMED','CHECKED_IN')) AS active,
                  coalesce(sum(total_amount) FILTER (WHERE status IN ('COMPLETED','CHECKED_IN','CONFIRMED','NO_SHOW')), 0) AS spent
             FROM reservations WHERE user_id = %s""",
        (uid,),
    )
    vehicles = query_all("SELECT * FROM vehicles WHERE user_id = %s ORDER BY vehicle_id", (uid,))
    return render_template(
        "dashboard.html", active=active, stats=stats, vehicles=vehicles,
        offers=queue_service.pending_offers(uid),
        waiting=[e for e in queue_service.user_entries(uid) if e["status"] == "WAITING"],
        user=query_one("SELECT * FROM users WHERE user_id = %s", (uid,)),
    )


@bp.route("/vehicles", methods=["GET", "POST"])
@login_required
def vehicles():
    uid = current_user_id()
    if request.method == "POST":
        try:
            v = validate_vehicle(request.form)
            with db_errors(), transaction() as cur:
                cur.execute(
                    """INSERT INTO vehicles (user_id, registration_no, vehicle_type, model_name, is_ev, connector_type)
                       VALUES (%s, %s, %s, %s, %s, %s)""",
                    (uid, v["registration_no"], v["vehicle_type"], v["model_name"], v["is_ev"], v["connector_type"]),
                )
            flash(f"Vehicle {v['registration_no']} added.", "success")
        except AppError as err:
            flash(err.message, "danger")
        return redirect(url_for("auth.vehicles"))

    rows = query_all(
        """SELECT v.*, (SELECT count(*) FROM reservations r WHERE r.vehicle_id = v.vehicle_id) AS bookings
             FROM vehicles v WHERE v.user_id = %s ORDER BY v.vehicle_id""",
        (uid,),
    )
    return render_template("vehicles.html", vehicles=rows, connectors=CONNECTORS)


@bp.route("/vehicles/<int:vehicle_id>/delete", methods=["POST"])
@login_required
def delete_vehicle(vehicle_id):
    try:
        with db_errors(), transaction() as cur:
            cur.execute("DELETE FROM vehicles WHERE vehicle_id = %s AND user_id = %s",
                        (vehicle_id, current_user_id()))
            if cur.rowcount == 0:
                raise AppError("NOT_FOUND", "Vehicle not found", 404)
        flash("Vehicle removed.", "info")
    except AppError as err:
        if err.code == "INVALID_REFERENCE":
            flash("This vehicle has bookings on record, so it cannot be deleted (ON DELETE RESTRICT).", "warning")
        else:
            flash(err.message, "danger")
    return redirect(url_for("auth.vehicles"))
