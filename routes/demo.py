"""Public-demo mode: give each visitor a private copy of the data and throw it
away when they refresh the page (see services/demo_sandbox.py)."""
from flask import Blueprint, current_app, flash, g, jsonify, redirect, request, session, url_for

from config.database import close_db, get_db, query_one
from routes.guards import safe_next
from services import demo_sandbox

bp = Blueprint("demo", __name__)


def _is_page_reload():
    """Browsers send Cache-Control: max-age=0 (or no-cache) when the user reloads a page.
    base.html has a JavaScript fallback for browsers that don't."""
    if request.method != "GET" or request.path.startswith("/api/"):
        return False
    if request.headers.get("Sec-Fetch-Dest", "document") != "document":
        return False
    if "text/html" not in request.headers.get("Accept", ""):
        return False
    cache = request.headers.get("Cache-Control", "")
    return "max-age=0" in cache or "no-cache" in cache


def _new_sandbox():
    close_db()                                   # its search_path points at the old schema
    g.sandbox = demo_sandbox.create(old=session.get("sandbox"))
    g.sandbox_fresh = True
    session["sandbox"] = g.sandbox
    # Accounts registered in the old copy no longer exist: log them out.
    if session.get("user_id") and not query_one("SELECT 1 AS ok FROM users WHERE user_id = %s",
                                                 (session["user_id"],)):
        for key in ("user_id", "name", "role"):
            session.pop(key, None)


def before_request():
    if not demo_sandbox.enabled(current_app) or request.endpoint in (None, "static"):
        return
    name = session.get("sandbox")
    g.sandbox = name if demo_sandbox.is_sandbox_name(name) else None
    g.sandbox_fresh = False
    if request.endpoint == "demo.reset":
        return
    if _is_page_reload() or not (g.sandbox and demo_sandbox.touch(get_db(), g.sandbox)):
        _new_sandbox()


@bp.route("/demo/reset", methods=["POST"])
def reset():
    if not demo_sandbox.enabled(current_app):
        return redirect(url_for("auth.index"))
    _new_sandbox()
    if request.is_json or "application/json" in request.headers.get("Accept", ""):
        return jsonify({"ok": True})
    flash("Demo data reset to the original sample data.", "info")
    return redirect(safe_next(request.form.get("next")) or url_for("auth.index"))
