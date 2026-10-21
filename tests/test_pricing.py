"""T12, T13 — dynamic pricing (all calculated by fn_calculate_price).

Fixed dates are used so results do not depend on when the test runs:
  2030-01-09 is a Wednesday, 2030-01-12 is a Saturday (India time).
Seed rates: default parking ₹40/h, AC ₹60/h, DC ₹150/h.
Peak: weekday 08–11 ×1.5, every day 17–21 ×1.5, weekend 11–17 ×1.25.
"""
from datetime import datetime

import pytest
from psycopg import errors

from services.timeutil import IST


def t(day, hour, minute=0):
    return datetime(2030, 1, day, hour, minute, tzinfo=IST)


def price(db, loc, slot_type, charger, start, end):
    return db.execute("SELECT * FROM fn_calculate_price(%s, %s, %s, %s, %s)",
                      (loc, slot_type, charger, start, end)).fetchone()


# --------------------------------------------------------------------------
# T12 Dynamic peak-hour pricing
# --------------------------------------------------------------------------
@pytest.mark.parametrize("start,end,expected,peak_min", [
    (t(9, 13), t(9, 15), 80.00, 0),       # Wed off-peak: 2 h × 40
    (t(9, 17), t(9, 19), 120.00, 120),    # Wed evening peak: 2 h × 40 × 1.5
    (t(9, 16), t(9, 18), 100.00, 60),     # half off-peak (40) + half peak (60)
    (t(9, 9), t(9, 10), 60.00, 60),       # weekday morning peak
    (t(12, 9), t(12, 10), 40.00, 0),      # Saturday 9 AM: weekday-only peak does NOT apply
    (t(12, 12), t(12, 14), 100.00, 120),  # Saturday shopping peak ×1.25
    (t(9, 13), t(9, 13, 45), 30.00, 0),   # 45 minutes is charged pro-rata
])
def test_T12_peak_hour_pricing(db, start, end, expected, peak_min):
    p = price(db, 1, "REGULAR", None, start, end)
    assert float(p["parking_fee"]) == expected
    assert p["charging_fee"] == 0
    assert p["peak_minutes"] == peak_min


def test_T12_admin_rate_change_applies_to_new_quotes(db):
    before = price(db, 1, "REGULAR", None, t(9, 13), t(9, 15))["total"]
    db.execute("UPDATE peak_hours SET multiplier = 2.0 WHERE label = 'Evening rush'")
    db.execute("UPDATE pricing_rules SET rate_per_hour = 50 WHERE location_id IS NULL AND applies_to = 'PARKING'")
    assert price(db, 1, "REGULAR", None, t(9, 13), t(9, 15))["total"] == 100 != before
    assert price(db, 1, "REGULAR", None, t(9, 17), t(9, 18))["total"] == 100   # 50 × 2.0


# --------------------------------------------------------------------------
# T13 Charger-type pricing (AC vs DC fast) and location-specific rules
# --------------------------------------------------------------------------
def test_T13_charger_type_pricing(db):
    ac = price(db, 1, "EV", "AC", t(9, 13), t(9, 15))
    dc = price(db, 1, "EV", "DC", t(9, 13), t(9, 15))
    assert (ac["parking_fee"], ac["charging_fee"], ac["total"]) == (80, 120, 200)   # 2h×40 + 2h×60
    assert (dc["parking_fee"], dc["charging_fee"], dc["total"]) == (80, 300, 380)   # 2h×40 + 2h×150
    assert dc["total"] > ac["total"]

    # DC in evening peak: (40 + 150) × 1.5 × 2h
    assert price(db, 1, "EV", "DC", t(9, 18), t(9, 20))["total"] == 570

    # Location-specific rules override the default
    vit = price(db, 4, "EV", "AC", t(9, 13), t(9, 15))           # VIT: parking 20, AC 40
    assert (vit["parking_fee"], vit["charging_fee"]) == (40, 80)
    mumbai = price(db, 6, "EV", "DC", t(9, 13), t(9, 15))        # Lower Parel: parking 80, DC 180
    assert (mumbai["parking_fee"], mumbai["charging_fee"]) == (160, 360)


def test_T13_price_errors(db):
    with pytest.raises(errors.RaiseException):
        price(db, 1, "EV", None, t(9, 13), t(9, 15))              # EV price needs a charger type
    with pytest.raises(errors.RaiseException):
        price(db, 1, "REGULAR", None, t(9, 15), t(9, 13))         # end before start
    db.execute("UPDATE pricing_rules SET is_active = FALSE WHERE applies_to = 'PARKING'")
    with pytest.raises(errors.RaiseException) as ex:
        price(db, 1, "REGULAR", None, t(9, 13), t(9, 15))
    assert ex.value.diag.message_hint == "NO_PRICING_RULE"
