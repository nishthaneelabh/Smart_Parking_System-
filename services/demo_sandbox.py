"""Public-demo mode: every visitor works on a private, throw-away copy of the data.

The real "parking" schema (tables, functions, triggers, views) is the
TEMPLATE and is never written to. For each visitor we create a schema
sb_<random> holding a copy of every table, view, foreign key and trigger,
filled by running database/seed.sql into it. The visitor's connections use

    search_path = sb_<random>, parking, public

so their queries hit their own tables, while the PL/pgSQL functions and
trigger functions (which live in "parking" and use unqualified table names)
run unchanged against the copy. Locks, EXCLUDE constraints and triggers all
behave exactly as in the normal app.

Refreshing the page (or "Reset demo") drops the copy and builds a new one,
so nothing a visitor does is kept. Idle copies are dropped after a few hours.

Turned on with DEMO_SANDBOX=1 (automatic on Vercel, which sets VERCEL=1).
"""
import os
import re
import secrets
from pathlib import Path

from psycopg import sql

from config.database import connect

ROOT = Path(__file__).resolve().parent.parent
SQL_DIR = ROOT / "database"
INIT_ORDER = ["schema.sql", "functions.sql", "procedures.sql", "triggers.sql", "indexes.sql", "seed.sql", "scheduler.sql"]

TEMPLATE = "parking"
REGISTRY = "demo_sandbox"          # bookkeeping schema: which sandboxes exist
IDLE_HOURS = 3                     # drop a sandbox nobody used for this long
MAX_SANDBOXES = 300                # hard cap so the free database never fills up
LOCK_KEY = 74_210_001              # pg_advisory_xact_lock key for one-time setup

_SANDBOX_NAME = re.compile(r"^sb_[0-9a-f]{16}$")
_ddl_cache = {}                    # template oid -> list of DDL statements


def enabled(app=None):
    if app is not None and "DEMO_SANDBOX" in app.config:
        return bool(app.config["DEMO_SANDBOX"])
    flag = os.environ.get("DEMO_SANDBOX")
    if flag is not None:
        return flag == "1"
    return bool(os.environ.get("VERCEL"))


def is_sandbox_name(name):
    return bool(name and _SANDBOX_NAME.match(name))


# ---------------------------------------------------------------------------
# One-time setup
# ---------------------------------------------------------------------------
def _ensure_template(conn):
    """Create the registry, and the whole "parking" schema if the database is empty."""
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        conn.execute(f"""
            CREATE SCHEMA IF NOT EXISTS {REGISTRY};
            CREATE TABLE IF NOT EXISTS {REGISTRY}.sandboxes (
                name         TEXT PRIMARY KEY,
                template_oid OID         NOT NULL,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
        if conn.execute("SELECT to_regclass('parking.reservations') AS t").fetchone()["t"] is None:
            for name in INIT_ORDER:
                conn.execute((SQL_DIR / name).read_text(encoding="utf-8"))
    return conn.execute("SELECT %s::regnamespace::oid AS oid", (TEMPLATE,)).fetchone()["oid"]


def _template_ddl(conn, template_oid):
    """CREATE statements (with a {schema} placeholder) that rebuild the template's
    tables, foreign keys, triggers and views in another schema. Read from the
    catalog once per process."""
    if template_oid in _ddl_cache:
        return _ddl_cache[template_oid]

    with conn.transaction():
        # With only "parking" on the path, pg_get_*def() prints unqualified names,
        # which then resolve to the sandbox's own tables.
        conn.execute("SET LOCAL search_path = parking")
        tables = [r["relname"] for r in conn.execute(
            """SELECT relname FROM pg_class
                WHERE relnamespace = %s AND relkind = 'r' ORDER BY oid""", (template_oid,))]
        fkeys = conn.execute(
            """SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def
                 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
                WHERE k.connamespace = %s AND k.contype = 'f' ORDER BY k.oid""", (template_oid,)).fetchall()
        triggers = [r["def"] for r in conn.execute(
            """SELECT pg_get_triggerdef(t.oid) AS def
                 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relnamespace = %s AND NOT t.tgisinternal ORDER BY t.oid""", (template_oid,))]
        views = conn.execute(
            """SELECT relname, pg_get_viewdef(oid, true) AS def FROM pg_class
                WHERE relnamespace = %s AND relkind = 'v' ORDER BY oid""", (template_oid,)).fetchall()

    ddl = [f'CREATE TABLE "{{schema}}"."{t}" (LIKE parking."{t}" INCLUDING ALL)' for t in tables]
    ddl += [f'ALTER TABLE "{{schema}}"."{f["relname"]}" ADD CONSTRAINT "{f["conname"]}" {f["def"]}' for f in fkeys]
    # pg_get_triggerdef() always schema-qualifies the table: point it at the sandbox
    ddl += [re.sub(r" ON parking\.(\w+) ", r' ON "{schema}".\1 ', t, count=1) for t in triggers]
    ddl += [f'CREATE VIEW "{{schema}}"."{v["relname"]}" AS {v["def"]}' for v in views]
    _ddl_cache[template_oid] = ddl
    return ddl


def _seed_script():
    """seed.sql, made to run inside the sandbox (search_path is set by the caller)."""
    text = (SQL_DIR / "seed.sql").read_text(encoding="utf-8")
    text = text.replace("SET search_path = parking, public;", "")
    text = text.replace("parking.parking_slots", "parking_slots").replace("parking.vehicles", "vehicles")
    return re.sub(r"^ANALYZE;$", "", text, flags=re.M)   # would analyse every sandbox in the database


# ---------------------------------------------------------------------------
# Sandboxes
# ---------------------------------------------------------------------------
def create(old=None, dsn=None):
    """Build a fresh sandbox (dropping `old` if given) and return its schema name."""
    name = "sb_" + secrets.token_hex(8)
    with connect(dsn) as conn:
        template_oid = _ensure_template(conn)
        ddl = _template_ddl(conn, template_oid)
        if is_sandbox_name(old):
            _drop(conn, old)
        _drop_stale(conn)
        with conn.transaction():
            conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(name)))
            conn.execute(sql.SQL("SET LOCAL search_path = {}, parking, public").format(sql.Identifier(name)))
            for stmt in ddl:
                conn.execute(stmt.replace("{schema}", name))
            conn.execute(_seed_script())
            conn.execute(f"INSERT INTO {REGISTRY}.sandboxes (name, template_oid) VALUES (%s, %s)",
                         (name, template_oid))
    return name


def touch(conn, name):
    """True if the sandbox still exists and matches the current template; marks it as used."""
    if not is_sandbox_name(name):
        return False
    try:
        row = conn.execute(
            f"""UPDATE {REGISTRY}.sandboxes SET last_seen = now()
                 WHERE name = %s AND template_oid = to_regnamespace(%s)::oid
                   AND to_regnamespace(name) IS NOT NULL
             RETURNING name""", (name, TEMPLATE)).fetchone()
    except Exception:            # registry not created yet
        return False
    return row is not None


def _drop(conn, name):
    with conn.transaction():
        conn.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(name)))
        conn.execute(f"DELETE FROM {REGISTRY}.sandboxes WHERE name = %s", (name,))


def _drop_stale(conn, limit=5):
    """Drop a few idle (or orphaned) sandboxes, and the oldest ones beyond MAX_SANDBOXES."""
    rows = conn.execute(
        f"""SELECT name FROM {REGISTRY}.sandboxes
             WHERE last_seen < now() - make_interval(hours => %s)
                OR template_oid <> to_regnamespace(%s)::oid
            UNION
            SELECT name FROM (SELECT name FROM {REGISTRY}.sandboxes
                               ORDER BY last_seen DESC OFFSET %s) extra
            LIMIT %s""", (IDLE_HOURS, TEMPLATE, MAX_SANDBOXES - 1, limit)).fetchall()
    for r in rows:
        if is_sandbox_name(r["name"]):
            _drop(conn, r["name"])
