// REAL results recorded from PostgreSQL by scripts/record_concurrency.py.
// Two separate database connections raced for the same slot; nothing here is simulated.
window.RECORDED_CONCURRENCY = {
 "recorded_at": "21 Oct 2026, 03:43 PM IST",
 "environment": "PostgreSQL 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1), Python 3.14.4, psycopg 3.3.6, Linux",
 "slot": "Phoenix Marketcity E03 (slot 8)",
 "window": "22 Oct 2026 12:00–14:00 IST",
 "runs": {
  "wait": {
   "mode": "FOR UPDATE (wait)",
   "hold_seconds": 2,
   "events": [
    {
     "t_ms": 6.6,
     "who": "User B",
     "msg": "BEGIN (PostgreSQL backend pid 20617)"
    },
    {
     "t_ms": 6.7,
     "who": "User A",
     "msg": "BEGIN (PostgreSQL backend pid 20616)"
    },
    {
     "t_ms": 6.8,
     "who": "User B",
     "msg": "SELECT fn_create_reservation(...) → asks for row lock on slot 8 (FOR UPDATE)"
    },
    {
     "t_ms": 7.3,
     "who": "User A",
     "msg": "SELECT fn_create_reservation(...) → asks for row lock on slot 8 (FOR UPDATE)"
    },
    {
     "t_ms": 21.6,
     "who": "User A",
     "msg": "Lock granted after 15 ms → reservation #21 inserted (HELD)"
    },
    {
     "t_ms": 21.6,
     "who": "User A",
     "msg": "Keeping the transaction open for 2s (pg_sleep) — other user must wait"
    },
    {
     "t_ms": 2025.9,
     "who": "User A",
     "msg": "COMMIT ✔ reservation #21 saved"
    },
    {
     "t_ms": 2032.4,
     "who": "User B",
     "msg": "ROLLBACK ✖ SLOT_UNAVAILABLE: Slot Unavailable: it is already reserved for an overlapping time"
    }
   ],
   "results": [
    {
     "user": "Demo User A",
     "label": "User A",
     "user_id": 13,
     "backend_pid": 20616,
     "waited_ms": 14.9,
     "ok": true,
     "reservation_id": 21
    },
    {
     "user": "Demo User B",
     "label": "User B",
     "user_id": 14,
     "backend_pid": 20617,
     "ok": false,
     "waited_ms": 2025.9,
     "error_code": "SLOT_UNAVAILABLE",
     "error": "Slot Unavailable: it is already reserved for an overlapping time"
    }
   ],
   "successful_bookings": 1,
   "active_overlapping_rows": 1,
   "double_booking_prevented": true
  },
  "nowait": {
   "mode": "NOWAIT",
   "hold_seconds": 1,
   "events": [
    {
     "t_ms": 6.5,
     "who": "User B",
     "msg": "BEGIN (PostgreSQL backend pid 20623)"
    },
    {
     "t_ms": 6.7,
     "who": "User A",
     "msg": "BEGIN (PostgreSQL backend pid 20622)"
    },
    {
     "t_ms": 6.9,
     "who": "User B",
     "msg": "SELECT fn_create_reservation(...) → asks for row lock on slot 8 (FOR UPDATE NOWAIT)"
    },
    {
     "t_ms": 7.1,
     "who": "User A",
     "msg": "SELECT fn_create_reservation(...) → asks for row lock on slot 8 (FOR UPDATE NOWAIT)"
    },
    {
     "t_ms": 12.3,
     "who": "User A",
     "msg": "ROLLBACK ✖ SLOT_BUSY: Another user is booking this slot right now. Please try again."
    },
    {
     "t_ms": 22.7,
     "who": "User B",
     "msg": "Lock granted after 16 ms → reservation #22 inserted (HELD)"
    },
    {
     "t_ms": 22.7,
     "who": "User B",
     "msg": "Keeping the transaction open for 1s (pg_sleep) — other user must wait"
    },
    {
     "t_ms": 1024.9,
     "who": "User B",
     "msg": "COMMIT ✔ reservation #22 saved"
    }
   ],
   "results": [
    {
     "user": "Demo User A",
     "label": "User A",
     "user_id": 13,
     "backend_pid": 20622,
     "ok": false,
     "waited_ms": 5.5,
     "error_code": "SLOT_BUSY",
     "error": "Another user is booking this slot right now. Please try again."
    },
    {
     "user": "Demo User B",
     "label": "User B",
     "user_id": 14,
     "backend_pid": 20623,
     "waited_ms": 16.1,
     "ok": true,
     "reservation_id": 22
    }
   ],
   "successful_bookings": 1,
   "active_overlapping_rows": 1,
   "double_booking_prevented": true
  }
 },
 "race": {
  "rounds": 30,
  "wins": {
   "User A": 15,
   "User B": 15
  },
  "rounds_with_not_exactly_one_success": 0
 }
};
