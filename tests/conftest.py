"""Shared test fixtures.

The tests use a SEPARATE database (TEST_DATABASE_URL in .env), which is
dropped and rebuilt at the start of the run, and re-seeded before every
test so each test starts from the same known data.

    pytest -v
"""
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

TEST_DSN = os.environ.get("TEST_DATABASE_URL")
if not TEST_DSN:
    pytest.exit("Set TEST_DATABASE_URL in .env (a separate database — it is wiped by the tests).", returncode=2)
if TEST_DSN == os.environ.get("DATABASE_URL"):
    pytest.exit("TEST_DATABASE_URL must be different from DATABASE_URL (tests wipe the database).", returncode=2)

# The Flask app and services read DATABASE_URL — point them at the test DB.
os.environ["DATABASE_URL"] = TEST_DSN

from config.database import connect  # noqa: E402
from scripts.init_db import build, run_files  # noqa: E402
from services.timeutil import IST  # noqa: E402

# Seed IDs (stable because seed.sql uses TRUNCATE ... RESTART IDENTITY)
ADMIN_ID = 1
ROHAN, MEERA, RAHUL, PRIYA, ARJUN, KAVYA, VIKRAM, SNEHA, IRFAN, DIVYA, KARTHIK, DEMO_A, DEMO_B = range(2, 15)
VEH = {  # vehicle_id by owner
    "rohan_ev": 1, "rohan_car": 2, "meera_ev": 3, "rahul_car": 4, "priya_ev": 5, "arjun_ev": 6,
    "kavya_ev": 7, "vikram_suv": 8, "sneha_ev": 9, "irfan_ev": 10, "divya_ev": 11, "karthik_bike": 12,
    "demo_a_ev": 13, "demo_b_ev": 14, "meera_car": 15,
}


@pytest.fixture(scope="session", autouse=True)
def _build_test_database():
    build(TEST_DSN, seed=False, quiet=True)
    yield


@pytest.fixture(autouse=True)
def fresh_seed():
    """Reload the sample data before every test."""
    run_files(TEST_DSN, ["seed.sql"], quiet=True)
    yield


@pytest.fixture
def db():
    """An autocommit connection to the test database."""
    conn = connect(TEST_DSN)
    yield conn
    conn.close()


@pytest.fixture
def new_conn():
    """Factory for extra independent connections (for concurrency tests)."""
    opened = []

    def make():
        c = connect(TEST_DSN)
        opened.append(c)
        return c
    yield make
    for c in opened:
        c.close()


@pytest.fixture
def app():
    from app import create_app
    return create_app({"TESTING": True, "WTF_CSRF_ENABLED": False})


@pytest.fixture
def client(app):
    return app.test_client()


def local(days=2, hour=10, minute=0):
    """An IST datetime `days` from today at hour:minute (future, inside the 30-day booking window)."""
    d = datetime.now(IST) + timedelta(days=days)
    return d.replace(hour=hour, minute=minute, second=0, microsecond=0)


def slot_id(db, location_id, code):
    return db.execute("SELECT slot_id FROM parking_slots WHERE location_id = %s AND slot_code = %s",
                      (location_id, code)).fetchone()["slot_id"]


def book(db, user, vehicle, slot, start, end):
    """Call the safe booking function inside an explicit transaction."""
    with db.transaction():
        return db.execute("SELECT fn_create_reservation(%s, %s, %s, %s, %s) AS id",
                          (user, vehicle, slot, start, end)).fetchone()["id"]


def hint_of(excinfo):
    return excinfo.value.diag.message_hint
