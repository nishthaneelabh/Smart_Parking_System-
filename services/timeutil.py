"""Date/time helpers. All times shown to users are India Standard Time."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from config.database import APP_TIMEZONE, AppError

IST = ZoneInfo(APP_TIMEZONE)


def now_ist():
    return datetime.now(IST)


def parse_local(value, field="time"):
    """Parse '2026-10-22T18:00' (from <input type="datetime-local">) as IST."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=IST)
    if not value:
        raise AppError("INVALID_TIME", f"Please enter a {field}")
    try:
        dt = datetime.fromisoformat(str(value).strip())
    except ValueError:
        raise AppError("INVALID_TIME", f"Invalid {field}: {value}")
    return dt if dt.tzinfo else dt.replace(tzinfo=IST)


def parse_window(start_raw, end_raw):
    start = parse_local(start_raw, "start time")
    end = parse_local(end_raw, "end time")
    if end <= start:
        raise AppError("INVALID_TIME", "End time must be after start time")
    return start, end


def default_window():
    """Next full hour + 2 hours — used to pre-fill search forms."""
    start = (now_ist() + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    return start, start + timedelta(hours=2)


def to_input(dt):
    """datetime -> value for <input type="datetime-local">."""
    return dt.astimezone(IST).strftime("%Y-%m-%dT%H:%M") if dt else ""


def fmt(dt, pattern="%d %b %Y, %I:%M %p"):
    return dt.astimezone(IST).strftime(pattern) if dt else "—"
