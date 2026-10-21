"""Build (or rebuild) the database without needing psql on your PATH.

    python scripts/init_db.py              # uses DATABASE_URL from .env
    python scripts/init_db.py --no-seed    # tables + logic only, no sample data
    python scripts/init_db.py --seed-only  # just reload sample data

It creates the database if it does not exist, then runs the SQL files in
the documented order. Equivalent to:  psql -d smart_parking -f database/setup.sql
"""
import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
SQL_DIR = ROOT / "database"
ORDER = ["schema.sql", "functions.sql", "procedures.sql", "triggers.sql", "indexes.sql", "seed.sql", "scheduler.sql"]


def ensure_database(dsn):
    """CREATE DATABASE if it is missing (connects to the 'postgres' maintenance DB)."""
    parts = urlparse(dsn)
    dbname = parts.path.lstrip("/")
    admin_dsn = urlunparse(parts._replace(path="/postgres"))
    with psycopg.connect(admin_dsn, autocommit=True) as conn:
        exists = conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,)).fetchone()
        if not exists:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))
            print(f"Created database {dbname}")


def run_files(dsn, files, quiet=False):
    with psycopg.connect(dsn, autocommit=True) as conn:
        if not quiet:
            conn.add_notice_handler(lambda d: print(f"   NOTICE: {d.message_primary}")
                                    if "drop cascades" not in d.message_primary and "already exists" not in d.message_primary
                                    else None)
        for name in files:
            if not quiet:
                print(f"-> {name}")
            # Each file is plain SQL (no psql meta-commands), so it can be sent as one script.
            conn.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def build(dsn, seed=True, quiet=False):
    ensure_database(dsn)
    files = [f for f in ORDER if seed or f != "seed.sql"]
    run_files(dsn, files, quiet)


def main():
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", default=os.environ.get("DATABASE_URL"), help="defaults to DATABASE_URL")
    parser.add_argument("--no-seed", action="store_true")
    parser.add_argument("--seed-only", action="store_true")
    args = parser.parse_args()
    if not args.dsn:
        sys.exit("DATABASE_URL is not set. Copy .env.example to .env first.")
    try:
        if args.seed_only:
            run_files(args.dsn, ["seed.sql"])
        else:
            build(args.dsn, seed=not args.no_seed)
    except psycopg.OperationalError as exc:
        sys.exit(f"Could not connect to PostgreSQL:\n{exc}\nCheck DATABASE_URL in .env and that PostgreSQL is running.")
    print("Database ready.")


if __name__ == "__main__":
    main()
