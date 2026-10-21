"""Command-line double-booking demonstration (two real PostgreSQL connections).

    python scripts/concurrency_demo.py                  # slot 8, tomorrow 12:00-14:00
    python scripts/concurrency_demo.py --slot 3 --hold 3
    python scripts/concurrency_demo.py --nowait
    python scripts/concurrency_demo.py --race 50        # 50 rounds with no delay at all

Each round: Demo User A and Demo User B try to reserve the SAME slot for the
SAME time at the same instant. Expected: exactly one succeeds, the other
gets SLOT_UNAVAILABLE (or SLOT_BUSY with --nowait).
"""
import argparse
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

from services.booking_service import run_concurrency_demo  # noqa: E402
from services.timeutil import IST  # noqa: E402


def main():
    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--slot", type=int, default=8, help="slot_id (default 8 = Phoenix Marketcity E03, DC CCS2)")
    p.add_argument("--start", help="e.g. 2026-10-25T12:00 (default: tomorrow 12:00 IST)")
    p.add_argument("--hours", type=float, default=2)
    p.add_argument("--hold", type=float, default=2, help="seconds the winner keeps its transaction open")
    p.add_argument("--nowait", action="store_true")
    p.add_argument("--race", type=int, default=0, help="run N rounds with hold=0 and report totals")
    a = p.parse_args()

    start = (datetime.fromisoformat(a.start).replace(tzinfo=IST) if a.start else
             (datetime.now(IST) + timedelta(days=1)).replace(hour=12, minute=0, second=0, microsecond=0))
    end = start + timedelta(hours=a.hours)
    dsn = os.environ.get("DATABASE_URL")

    if a.race:
        violations = 0
        winners = {"User A": 0, "User B": 0}
        for i in range(a.race):
            r = run_concurrency_demo(a.slot, start, end, hold_seconds=0, nowait=a.nowait, cleanup=True, dsn=dsn)
            if not r["double_booking_prevented"] or r["successful_bookings"] != 1:
                violations += 1
            for res in r["results"]:
                if res.get("ok"):
                    winners[res["label"]] += 1
        print(f"{a.race} rounds: wins A={winners['User A']} B={winners['User B']}, "
              f"rounds with != 1 successful booking: {violations}")
        sys.exit(1 if violations else 0)

    r = run_concurrency_demo(a.slot, start, end, hold_seconds=a.hold, nowait=a.nowait, cleanup=True, dsn=dsn)
    print(f"\nSlot {a.slot}  {start:%d %b %H:%M} – {end:%H:%M} IST   mode: {r['mode']}\n")
    for e in r["events"]:
        print(f"{e['t_ms']:9.1f} ms  {e['who']:<7} {e['msg']}")
    print()
    for res in r["results"]:
        outcome = f"BOOKED #{res['reservation_id']}" if res.get("ok") else f"REJECTED {res['error_code']}: {res['error']}"
        print(f"{res['label']} ({res['user']}, pid {res.get('backend_pid')}): {outcome}  [waited {res.get('waited_ms')} ms]")
    print(f"\nActive overlapping reservations for this slot/time: {r['active_overlapping_rows']}")
    print("RESULT:", "double booking PREVENTED" if r["double_booking_prevented"] else "DOUBLE BOOKING!")
    if r["cleaned_up"]:
        print(f"(cleaned up reservation(s) {r['cleaned_up']} so the demo can be repeated)")


if __name__ == "__main__":
    main()
