"""Database connection management and error translation.

Every web request gets its own PostgreSQL connection (stored on flask.g)
in AUTOCOMMIT mode. Anything that changes data is wrapped in

    with transaction() as cur:      # sends BEGIN
        cur.execute(...)            # one or more statements
                                    # COMMIT on success, ROLLBACK on error

so the transaction boundaries are explicit and easy to point at in a viva.
All SQL uses %s placeholders (parameterized queries) — never string
formatting — which makes SQL injection impossible.
"""
import os
from contextlib import contextmanager

import psycopg
from psycopg import errors as pg_errors
from psycopg.rows import dict_row
from flask import g

APP_TIMEZONE = "Asia/Kolkata"


def get_dsn():
    # Hosted Postgres (Neon via Vercel) also provides an unpooled URL; prefer it,
    # because the pooler rejects the "options" startup parameter used in connect().
    dsn = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError(
            "DATABASE_URL is not set. Copy .env.example to .env and fill in your PostgreSQL password."
        )
    # Neon pooled host "ep-xxx-pooler.region..." -> direct host "ep-xxx.region..."
    return dsn.replace("-pooler.", ".")


def connect(dsn=None, sandbox=None):
    """Open a NEW independent connection (used directly by tests, scripts and
    the concurrency demo, which needs two separate connections).

    sandbox: a visitor's private demo schema (services/demo_sandbox.py); its
    tables are found first, functions still come from "parking"."""
    path = f"{sandbox},parking,public" if sandbox else "parking,public"
    return psycopg.connect(
        dsn or get_dsn(),
        autocommit=True,
        row_factory=dict_row,
        options=f"-c search_path={path} -c timezone={APP_TIMEZONE}",
    )


def current_sandbox():
    """The demo sandbox of the current request, or None (normal mode / no request)."""
    try:
        return g.get("sandbox")
    except RuntimeError:          # outside a Flask app context
        return None


def get_db():
    """The connection for the current request (opened on first use)."""
    if "db" not in g:
        g.db = connect(sandbox=g.get("sandbox"))
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


@contextmanager
def transaction(conn=None):
    """BEGIN ... COMMIT (or ROLLBACK if an exception escapes)."""
    conn = conn or get_db()
    with conn.transaction():
        with conn.cursor() as cur:
            yield cur


def query_all(sql, params=None):
    with get_db().cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def query_one(sql, params=None):
    with get_db().cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------
class AppError(Exception):
    """An error that is safe to show to the user."""

    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def to_dict(self):
        return {"ok": False, "error": {"code": self.code, "message": self.message}}


# HTTP status for each business error code raised by the PL/pgSQL functions
_STATUS_BY_CODE = {
    "SLOT_UNAVAILABLE": 409,
    "SLOT_BUSY": 409,
    "VEHICLE_ALREADY_BOOKED": 409,
    "ALREADY_WAITING": 409,
    "SLOTS_AVAILABLE": 409,
    "SLOT_OCCUPIED": 409,
    "RESERVATION_NOT_FOUND": 404,
    "SLOT_NOT_FOUND": 404,
    "CHARGER_NOT_FOUND": 404,
    "LOCATION_NOT_FOUND": 404,
}


def translate_db_error(exc):
    """Turn a psycopg exception into an AppError with a friendly message."""
    if isinstance(exc, AppError):
        return exc
    diag = getattr(exc, "diag", None)
    if isinstance(exc, pg_errors.RaiseException) and diag and diag.message_hint:
        code = diag.message_hint
        return AppError(code, diag.message_primary, _STATUS_BY_CODE.get(code, 400))
    if isinstance(exc, pg_errors.ExclusionViolation):
        return AppError("SLOT_UNAVAILABLE", "Slot Unavailable: it is already reserved for an overlapping time", 409)
    if isinstance(exc, pg_errors.LockNotAvailable):
        return AppError("SLOT_BUSY", "Another user is booking this slot right now. Please try again.", 409)
    if isinstance(exc, pg_errors.UniqueViolation):
        constraint = diag.constraint_name if diag else ""
        friendly = {
            "uq_users_email": "An account with this email already exists",
            "uq_users_phone": "An account with this phone number already exists",
            "uq_vehicles_registration": "This vehicle registration number is already registered",
            "uq_slots_location_code": "A slot with this code already exists at this location",
            "uq_locations_name_city": "A location with this name already exists in this city",
            "uq_chargers_slot": "This slot already has a charger",
        }.get(constraint, "This record already exists")
        return AppError("DUPLICATE", friendly, 409)
    if isinstance(exc, pg_errors.CheckViolation):
        constraint = diag.constraint_name if diag else ""
        return AppError("INVALID_INPUT", f"Invalid value (rule {constraint} was violated)", 400)
    if isinstance(exc, (pg_errors.ForeignKeyViolation, pg_errors.RestrictViolation)):
        return AppError("INVALID_REFERENCE", "This record is linked to other data and cannot be changed that way", 400)
    if isinstance(exc, pg_errors.NotNullViolation):
        return AppError("MISSING_FIELD", f"Missing required field: {diag.column_name if diag else ''}", 400)
    if isinstance(exc, pg_errors.InvalidDatetimeFormat) or isinstance(exc, pg_errors.DatetimeFieldOverflow):
        return AppError("INVALID_TIME", "Invalid date/time", 400)
    return AppError("DATABASE_ERROR", "Unexpected database error. Please try again.", 500)


@contextmanager
def db_errors():
    """Use as `with db_errors():` around database work to get AppError only."""
    try:
        yield
    except psycopg.Error as exc:
        raise translate_db_error(exc) from exc
