"""Login / role checks used by every blueprint."""
from functools import wraps

from flask import abort, flash, jsonify, redirect, request, session, url_for


def _wants_json():
    return request.path.startswith("/api/") or request.is_json


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if _wants_json():
                return jsonify({"ok": False, "error": {"code": "LOGIN_REQUIRED",
                                                       "message": "Please log in first"}}), 401
            flash("Please log in to continue.", "warning")
            return redirect(url_for("auth.login", next=request.full_path))
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    """Server-side role check — hiding a button is NOT security."""
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if session.get("role") != "ADMIN":
            if _wants_json():
                return jsonify({"ok": False, "error": {"code": "FORBIDDEN",
                                                       "message": "Admin access only"}}), 403
            abort(403, description="This page is only for administrators.")
        return view(*args, **kwargs)
    return wrapped


def current_user_id():
    return session.get("user_id")


def is_admin():
    return session.get("role") == "ADMIN"


def safe_next(target):
    """Only allow redirects to paths on this site (prevents open redirects)."""
    if target and target.startswith("/") and not target.startswith("//"):
        return target
    return None
