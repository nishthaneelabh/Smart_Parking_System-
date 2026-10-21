"""Record REAL concurrency runs from PostgreSQL for the static demo site.

    python scripts/record_concurrency.py

Runs the two-connection booking race against your database (WAIT mode,
NOWAIT mode and 30 no-delay rounds) and writes the genuine results to
demo/js/recorded-concurrency.js. The static demo replays this file; it
never invents concurrency results. Every demo booking is cancelled
afterwards.
"""
import json
import os
import platform
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

from services.booking_service import run_concurrency_demo  # noqa: E402
from services.timeutil import IST  # noqa: E402

SLOT_ID = 8          # Phoenix Marketcity E03 (DC, CCS2)
RACE_ROUNDS = 30
KEEP = ("mode", "hold_seconds", "events", "results", "successful_bookings",
        "active_overlapping_rows", "double_booking_prevented")


def main():
    load_dotenv(ROOT / ".env")
    dsn = os.environ["DATABASE_URL"]
    start = (datetime.now(IST) + timedelta(days=1)).replace(hour=12, minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=2)
    with psycopg.connect(dsn) as conn:
        version = conn.execute("SHOW server_version").fetchone()[0]

    wait_run = run_concurrency_demo(SLOT_ID, start, end, hold_seconds=2, nowait=False, cleanup=True, dsn=dsn)
    nowait_run = run_concurrency_demo(SLOT_ID, start, end, hold_seconds=1, nowait=True, cleanup=True, dsn=dsn)

    wins = {"User A": 0, "User B": 0}
    bad_rounds = 0
    for _ in range(RACE_ROUNDS):
        r = run_concurrency_demo(SLOT_ID, start, end, hold_seconds=0, cleanup=True, dsn=dsn)
        if r["successful_bookings"] != 1 or not r["double_booking_prevented"]:
            bad_rounds += 1
        for res in r["results"]:
            if res.get("ok"):
                wins[res["label"]] += 1

    out = {
        "recorded_at": datetime.now(IST).strftime("%d %b %Y, %I:%M %p IST"),
        "environment": f"PostgreSQL {version}, Python {platform.python_version()}, "
                       f"psycopg {psycopg.__version__}, {platform.system()}",
        "slot": f"Phoenix Marketcity E03 (slot {SLOT_ID})",
        "window": f"{start:%d %b %Y} 12:00–14:00 IST",
        "runs": {"wait": {k: wait_run[k] for k in KEEP}, "nowait": {k: nowait_run[k] for k in KEEP}},
        "race": {"rounds": RACE_ROUNDS, "wins": wins, "rounds_with_not_exactly_one_success": bad_rounds},
    }
    target = ROOT / "demo" / "js" / "recorded-concurrency.js"
    target.write_text(
        "// REAL results recorded from PostgreSQL by scripts/record_concurrency.py.\n"
        "// Two separate database connections raced for the same slot; nothing here is simulated.\n"
        "window.RECORDED_CONCURRENCY = " + json.dumps(out, indent=1, default=str, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    print(f"Wrote {target.relative_to(ROOT)}")
    print(f"  {out['environment']}")
    print(f"  race: {RACE_ROUNDS} rounds, wins {wins}, rounds without exactly one success: {bad_rounds}")


if __name__ == "__main__":
    main()
