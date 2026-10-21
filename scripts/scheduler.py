"""Runs the automatic reservation maintenance every minute.

    python scripts/scheduler.py            # loop forever (Ctrl+C to stop)
    python scripts/scheduler.py --once     # run one time and exit
    python scripts/scheduler.py --interval 30

All logic is inside PostgreSQL (fn_run_expiry_jobs / sp_run_scheduled_jobs).
This script only calls it — use it when pg_cron is not installed.
Running it twice at the same time is safe: the function uses
FOR UPDATE SKIP LOCKED and only touches rows that are still due.
"""
import argparse
import os
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

from config.database import connect  # noqa: E402


def run_once(conn):
    with conn.transaction():
        row = conn.execute("SELECT * FROM fn_run_expiry_jobs()").fetchone()
    stamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{stamp}] expired holds={row['expired_holds']}  no-shows={row['no_shows']}  "
          f"expired waits={row['expired_waits']}  waiting-list offers={row['offers_made']}", flush=True)
    return row


def main():
    load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval", type=int, default=60, help="seconds between runs (default 60)")
    args = parser.parse_args()

    conn = connect(os.environ.get("DATABASE_URL"))
    print("Smart Parking scheduler started. Ctrl+C to stop.")
    try:
        while True:
            try:
                run_once(conn)
            except psycopg.OperationalError:
                print("Lost database connection, reconnecting...", flush=True)
                conn = connect(os.environ.get("DATABASE_URL"))
            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nScheduler stopped.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
