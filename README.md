# Smart Parking & EV Charging Reservation System
### High-Concurrency Database System for Real-Time Reservations — DBMS Project

Drivers search for parking slots and compatible EV chargers, reserve
them safely and pay. Administrators manage locations, slots, chargers and
bookings. **PostgreSQL itself guarantees that a slot can never be
double-booked**, even when many people book at the same instant.

**Stack:** PostgreSQL · Python 3 / Flask · psycopg 3 (plain SQL, no ORM) · Bootstrap 5 · pytest

| Highlights | Where |
|---|---|
| `SELECT … FOR UPDATE` / `NOWAIT` booking transaction | `database/functions.sql` → `fn_create_reservation` |
| `EXCLUDE USING gist (slot_id WITH =, booking_period WITH &&)` | `database/schema.sql` → `reservations` |
| Triggers: overstay fine, slot occupancy, faulty charger | `database/triggers.sql` |
| Dynamic peak / AC / DC pricing from tables | `fn_calculate_price` |
| Priority waiting list with 10-minute offers | `fn_process_waiting_list` |
| Auto-expiry of unpaid holds (pg_cron or Python) | `fn_run_expiry_jobs`, `scripts/scheduler.py` |
| Live two-connection double-booking demo | Admin → *Concurrency demo* |
| 52 automated tests (T01–T20) | `tests/` |

Documentation: [Project Report](docs/Project_Report.md) ·
[ER Diagram](docs/ER_Diagram.md) · [Database Schema](docs/Database_Schema.md) ·
[Test Cases](docs/Test_Cases.md) · [Demo Guide](docs/Demo_Guide.md) ·
[Viva Questions](docs/Viva_Questions.md)

---

## Quick start (if you already have Python and PostgreSQL)

```bash
git clone https://github.com/nishthaneelabh/Smart_Parking_System-.git
cd Smart_Parking_System-
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # Windows: copy .env.example .env   — then edit the password
python scripts/init_db.py          # creates the database, tables, functions, triggers, sample data
python app.py                      # open http://127.0.0.1:5000
```

On the login page, click any card under **Quick demo login**, e.g.
*Ananya Iyer (Admin)* or *Rohan Sharma*.

---

## Full installation guide (beginner, VS Code)

### 1. Install Python and PostgreSQL

**Windows**
1. Python 3.10 or newer from <https://www.python.org/downloads/>. **Tick "Add python.exe to PATH"** in the installer.
2. PostgreSQL 16 (any version ≥ 13 works) from <https://www.postgresql.org/download/windows/> (EDB installer).
   - Remember the password you set for the `postgres` user.
   - Keep port **5432**.
   - Untick "Stack Builder" at the end; it isn't needed.
3. Optional, to use `psql` from any terminal: add `C:\Program Files\PostgreSQL\16\bin` to your PATH.
   Otherwise use **SQL Shell (psql)** from the Start menu.

**Linux (Ubuntu/Debian)**
```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip postgresql postgresql-contrib
sudo systemctl enable --now postgresql
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"   # choose your own password
```
`postgresql-contrib` provides the `btree_gist` extension, which the project needs.

**macOS:** `brew install python postgresql@16 && brew services start postgresql@16`

### 2. Get the project and open it in VS Code
```bash
git clone https://github.com/nishthaneelabh/Smart_Parking_System-.git
cd Smart_Parking_System-
code .
```
In VS Code, open a terminal with **Terminal → New Terminal**. Install the
"Python" extension, and optionally "Markdown Preview Mermaid Support" to
view the ER diagram.

### 3. Create a virtual environment
```bash
python -m venv .venv          # Linux/macOS may need: python3 -m venv .venv
```
Activate it (do this in **every** new terminal):

| OS / shell | Command |
|---|---|
| Windows PowerShell | `.venv\Scripts\Activate.ps1` |
| Windows cmd | `.venv\Scripts\activate.bat` |
| Linux / macOS | `source .venv/bin/activate` |

Your prompt now starts with `(.venv)`. In VS Code also run
**Ctrl+Shift+P → Python: Select Interpreter → .venv**.

### 4. Install dependencies
```bash
pip install -r requirements.txt
```

### 5. Configure environment variables
Copy `.env.example` to `.env` (Windows: `copy .env.example .env`, Linux: `cp .env.example .env`) and edit it:
```ini
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/smart_parking
TEST_DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/smart_parking_test
SECRET_KEY=paste-a-random-string-here
```
Generate a secret key with `python -c "import secrets; print(secrets.token_hex(32))"`.
`.env` is in `.gitignore`. **Never commit your password.**

### 6–8. Create the database, tables, functions, triggers, indexes and sample data

**Option A — one Python command (recommended, works without psql):**
```bash
python scripts/init_db.py
```
This creates the `smart_parking` database if it is missing, then runs
`schema → functions → procedures → triggers → indexes → seed → scheduler`.

**Option B — with psql (shows each SQL file running):**
```bash
psql -U postgres -c "CREATE DATABASE smart_parking;"
psql -U postgres -d smart_parking -f database/setup.sql
```
Or run the files one by one, in this order: `schema.sql`, `functions.sql`,
`procedures.sql`, `triggers.sql`, `indexes.sql`, `seed.sql`, `scheduler.sql`.

Reset only the sample data at any time with:
`python scripts/init_db.py --seed-only`

### 9. (Optional) Automatic expiry with pg_cron
If you can install pg_cron (Linux: `sudo apt install postgresql-16-cron`):
1. Add these lines to `postgresql.conf`:
   ```ini
   shared_preload_libraries = 'pg_cron'
   cron.database_name = 'smart_parking'
   ```
2. Restart PostgreSQL and run `psql -d smart_parking -f database/scheduler.sql`.

Otherwise (the usual case on Windows), keep this running in a second terminal:
```bash
python scripts/scheduler.py          # runs every 60 s; --once for a single run
```
Both call the same stored procedure, `sp_run_scheduled_jobs()`.

### 10–11. Run the website
```bash
python app.py
```
Open **<http://127.0.0.1:5000>**.

| Account | Email | Password |
|---|---|---|
| Admin | admin@smartpark.in | Admin@123 |
| Users | rohan.sharma@example.in, arjun.mehta@example.in, … | Password@123 |

The login page lists all sample accounts as one-click cards. Set
`DEMO_LOGINS=0` in `.env` to hide them.

### 12. Run the tests
```bash
pytest -v
```
The tests use `TEST_DATABASE_URL`, a separate database that they create,
wipe and rebuild themselves. Expected result: **52 passed**.

### 13. Demonstrate concurrency with two terminals
**Easiest:** `python scripts/concurrency_demo.py` prints a timeline of two
connections racing for slot 8. Add `--nowait`, or `--race 50` for 50 rounds.

**By hand** (best for the examiner): open two terminals and run
`psql -U postgres -d smart_parking` in both. Then follow
`database/concurrency_demo.sql` step by step:
- Terminal 1 books and does **not** commit.
- Terminal 2's identical booking **hangs**.
- Terminal 1 runs `COMMIT;`.
- Terminal 2 immediately gets `ERROR: Slot Unavailable`.

In the browser, log in as admin and open **Admin → Concurrency demo**.

---

## Troubleshooting

| Error | Cause / fix |
|---|---|
| `DATABASE_URL is not set` | You have no `.env` file. Copy `.env.example` to `.env`. |
| `password authentication failed for user "postgres"` | Wrong password in `.env`. On Linux set one: `sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'newpass';"` |
| `connection refused` / `could not connect to server` | PostgreSQL is not running. Windows: Services → `postgresql-x64-16` → Start. Linux: `sudo systemctl start postgresql`. Check the port (5432) in `.env`. |
| `database "smart_parking" does not exist` | Run `python scripts/init_db.py` (it creates the database). |
| `extension "btree_gist" is not available` | Linux: `sudo apt install postgresql-contrib`. Windows: it ships with the EDB installer. |
| `permission denied to create extension "btree_gist"` | Connect as `postgres` (a superuser) or the database owner. |
| `'psql' is not recognized` (Windows) | Use `python scripts/init_db.py`, use "SQL Shell (psql)" from the Start menu, or add PostgreSQL's `bin` folder to PATH. |
| PowerShell: *running scripts is disabled* when activating the venv | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use cmd with `activate.bat`. |
| `ModuleNotFoundError: No module named 'flask'` | The venv is not active. Activate it, then `pip install -r requirements.txt`. |
| `ZoneInfoNotFoundError: Asia/Kolkata` (Windows) | `pip install tzdata` (already in requirements.txt). |
| `Address already in use` / port 5000 busy | Set `FLASK_PORT=5001` in `.env`. On macOS, disable AirPlay Receiver. |
| "Session expired — please reload" | The CSRF token is stale after a restart. Reload the page. |
| Booking says *Slot Unavailable* during the demo | That slot and time is already booked from an earlier run. Run `python scripts/init_db.py --seed-only`. |
| pytest exits: *TEST_DATABASE_URL must be different* | Point it to a different database name, e.g. `smart_parking_test`. |

---

## Project structure

```
Smart_Parking_System-/
├── app.py                    Flask app factory, CSRF, error handlers, template filters
├── requirements.txt  .env.example  .gitignore
├── config/database.py        connections, transaction(), error → message translation
├── database/
│   ├── schema.sql            13 tables, keys, CHECK and EXCLUDE constraints
│   ├── functions.sql         pricing, search, safe booking, payment, cancel, check-in/out,
│   │                         waiting list, expiry jobs, views
│   ├── procedures.sql        sp_run_scheduled_jobs, sp_mark_charger_faulty/_repaired
│   ├── triggers.sql          triggers A (fine), B (occupancy), C (faulty charger), audit, ...
│   ├── indexes.sql           indexes (with reasons)
│   ├── seed.sql              repeatable Indian sample data
│   ├── scheduler.sql         pg_cron job (if available)
│   ├── setup.sql             runs all of the above in order (psql)
│   ├── concurrency_demo.sql  two-terminal double-booking demo
│   ├── demo_queries.sql      verification queries for the examiner
│   ├── benchmark.sql         200k-row EXPLAIN ANALYZE benchmark (rolled back)
│   └── er_diagram.mmd        Mermaid ER diagram
├── routes/                   auth, parking, reservations, payments, waiting_list, admin, guards
├── services/                 booking_service, pricing_service, queue_service, timeutil
├── scripts/                  init_db.py, scheduler.py, concurrency_demo.py
├── templates/                base + user pages; admin_dashboard.html; admin/*.html
├── static/                   css/style.css, js/app.js, js/slots.js, js/concurrency.js, images/
├── tests/                    conftest + test_booking/_concurrency/_triggers/_waiting_list/_pricing
└── docs/                     report, ER, schema, test cases, demo guide, viva Q&A
```

Two small changes from the suggested structure:
- Admin sub-pages live in `templates/admin/` so there are not ten `admin_*.html` files at the top level.
- `routes/guards.py` (login and admin decorators) and `services/timeutil.py` (India-time helpers) were added so they are not repeated in every file.

---

## What works and what is future work

**Implemented and tested:**
- Registration and login with hashed passwords, roles and CSRF protection.
- Vehicles; location browsing; slot search with filters and vehicle and plug compatibility.
- Safe booking with a 10-minute hold, simulated payment (including a "failed payment" option), cancellation with refund, check-in and check-out, final bill and fine payment.
- Dynamic pricing, overstay fines, no-show handling.
- Priority waiting list with offers, faulty and repaired chargers, automatic expiry.
- Audit log, admin management pages, statistics and the live concurrency demo.

**Not implemented (future enhancements):**
- A real payment gateway.
- SMS or email notifications.
- Hardware sensors / number-plate cameras.
- Automatic relocation of a booking when a charger fails (the driver is put at the top of the waiting list instead).
- A map view.

**Verification status:**
- Everything above was run on Linux (Ubuntu, PostgreSQL 18.6, Python 3.14). The 52 tests pass, and the SQL demo scripts produce the outputs documented in them.
- The Windows instructions follow the standard installers but were **not** executed on Windows by us.
- pg_cron was not available in our environment, so the scheduler was verified through `scripts/scheduler.py`; the `scheduler.sql` pg_cron path is untested.

---

## For the viva

**A. How to run:** start PostgreSQL → `python scripts/init_db.py` → `python app.py` (and `python scripts/scheduler.py`) → <http://127.0.0.1:5000>.

**B. How to demonstrate:** follow [docs/Demo_Guide.md](docs/Demo_Guide.md). The highlight is step 7–8: the two-terminal or website concurrency demo.

**C. The five most important database concepts in this project**
1. **Transactions and ACID:** each booking, payment or cancellation is all-or-nothing.
2. **Row-level locking** (`SELECT … FOR UPDATE`, `NOWAIT`, `SKIP LOCKED`): concurrent bookings of the same slot take turns.
3. **Exclusion constraint on time ranges** (`tstzrange`, `&&`, GiST): the database itself forbids overlapping active reservations.
4. **Triggers and stored functions/procedures:** fines, occupancy, charger faults, pricing and the waiting list all run inside PostgreSQL.
5. **Normalization (3NF), keys and constraints, plus indexing:** a clean schema protected by FK, CHECK and UNIQUE rules, with indexes justified by EXPLAIN ANALYZE.

**D. What to study for the viva**
| File / object | Understand |
|---|---|
| `schema.sql` → `reservations` | every constraint, especially `ex_res_no_slot_overlap`; the status life cycle |
| `functions.sql` → `fn_create_reservation` | steps 1–8 and why the lock comes before the overlap check |
| `services/booking_service.py` → `create_reservation` | where BEGIN, COMMIT and ROLLBACK happen |
| `functions.sql` → `fn_calculate_price` | 15-minute pieces × rate × peak multiplier |
| `triggers.sql` → A, B, C | when each fires, BEFORE vs AFTER, how recursion is avoided |
| `functions.sql` → `fn_process_waiting_list` | ORDER BY, SKIP LOCKED, offer vs confirm |
| `functions.sql` → `fn_run_expiry_jobs` + `scheduler.sql` | why it is safe to run repeatedly |
| `indexes.sql` + `benchmark.sql` | why each index exists; reading EXPLAIN output |
| `docs/Viva_Questions.md` | 33 questions with answers |
