"""Smart Parking & EV Charging Reservation System — Flask entry point.

Run:  python app.py      (then open http://127.0.0.1:5000)
"""
import os
import secrets
from datetime import timedelta
from decimal import Decimal

from dotenv import load_dotenv
from flask import Flask, abort, jsonify, render_template, request, session
from flask.json.provider import DefaultJSONProvider

load_dotenv()

from config.database import AppError, close_db  # noqa: E402  (needs .env loaded first)
from services import timeutil  # noqa: E402


class JSONProvider(DefaultJSONProvider):
    """Send datetimes as ISO-8601 and money (Decimal) as numbers."""

    @staticmethod
    def default(o):
        if hasattr(o, "isoformat"):
            return o.isoformat()
        if isinstance(o, Decimal):
            return float(o)
        return DefaultJSONProvider.default(o)


def create_app(test_config=None):
    app = Flask(__name__)
    app.json_provider_class = JSONProvider
    app.json = JSONProvider(app)
    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY") or secrets.token_hex(32),
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        WTF_CSRF_ENABLED=True,
    )
    if test_config:
        app.config.update(test_config)

    from routes.admin import bp as admin_bp
    from routes.auth import bp as auth_bp
    from routes.parking import bp as parking_bp
    from routes.payments import bp as payments_bp
    from routes.reservations import bp as reservations_bp
    from routes.waiting_list import bp as waiting_bp

    for bp in (auth_bp, parking_bp, reservations_bp, payments_bp, waiting_bp, admin_bp):
        app.register_blueprint(bp)

    app.teardown_appcontext(close_db)

    # ------------------------------------------------------------------
    # CSRF protection: every POST must carry the session's token, either
    # as a hidden form field "csrf_token" or an "X-CSRF-Token" header.
    # ------------------------------------------------------------------
    def csrf_token():
        if "csrf_token" not in session:
            session["csrf_token"] = secrets.token_urlsafe(32)
        return session["csrf_token"]

    @app.before_request
    def check_csrf():
        if request.method == "POST" and app.config.get("WTF_CSRF_ENABLED", True):
            sent = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token")
            if not sent or sent != session.get("csrf_token"):
                if request.is_json or request.path.startswith("/api/"):
                    return jsonify(AppError("CSRF", "Session expired — please reload the page").to_dict()), 400
                abort(400, description="Your session expired. Please go back, reload the page and try again.")

    # ------------------------------------------------------------------
    # Template helpers
    # ------------------------------------------------------------------
    # Globals are visible inside imported macros too (context processors are not)
    app.jinja_env.globals.update(csrf_token=csrf_token, to_input=timeutil.to_input)

    @app.context_processor
    def inject_globals():
        return {
            "current_user": {
                "id": session.get("user_id"),
                "name": session.get("name"),
                "role": session.get("role"),
            } if session.get("user_id") else None,
        }

    @app.template_filter("inr")
    def inr(value):
        if value is None:
            return "—"
        return "₹{:,.2f}".format(Decimal(value))

    @app.template_filter("dt")
    def dt_filter(value, pattern="%d %b %Y, %I:%M %p"):
        return timeutil.fmt(value, pattern)

    STATUS_COLORS = {
        "HELD": "warning", "CONFIRMED": "primary", "CHECKED_IN": "info", "COMPLETED": "success",
        "CANCELLED": "secondary", "EXPIRED": "dark", "NO_SHOW": "danger",
        "WAITING": "warning", "OFFERED": "info", "ACCEPTED": "success",
        "OPERATIONAL": "success", "FAULTY": "danger", "FREE": "success", "OCCUPIED": "danger",
        "SUCCESS": "success", "FAILED": "danger", "REFUNDED": "secondary",
    }

    @app.template_filter("badge")
    def badge(status):
        return STATUS_COLORS.get(status, "secondary")

    # ------------------------------------------------------------------
    # Errors
    # ------------------------------------------------------------------
    @app.errorhandler(AppError)
    def handle_app_error(err):
        if request.path.startswith("/api/") or request.is_json:
            return jsonify(err.to_dict()), err.status
        return render_template("error.html", code=err.status, title=err.code.replace("_", " ").title(),
                               message=err.message), err.status

    @app.errorhandler(400)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(500)
    def handle_http_error(err):
        code = getattr(err, "code", 500) or 500
        titles = {400: "Bad request", 403: "Access denied", 404: "Page not found", 500: "Server error"}
        message = getattr(err, "description", None) or "Something went wrong."
        if code == 500:
            message = "Something went wrong on our side. Check the Flask terminal for details."
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": {"code": titles[code].upper().replace(" ", "_"),
                                                   "message": message}}), code
        return render_template("error.html", code=code, title=titles.get(code, "Error"), message=message), code

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG", "1") == "1",
            host=os.environ.get("FLASK_HOST", "127.0.0.1"),
            port=int(os.environ.get("FLASK_PORT", "5000")),
            threaded=True)
