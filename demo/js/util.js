// Small helpers shared by the demo (time in India Standard Time, money, escaping).
// IST is UTC+05:30 all year (no daylight saving), so a fixed offset is exact.
(function () {
  const IST_MS = 330 * 60 * 1000;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // Clock parts of a Date as seen in India
  function ist(d) {
    const t = new Date(d.getTime() + IST_MS);
    return {
      y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(),
      h: t.getUTCHours(), mi: t.getUTCMinutes(),
      isoDow: ((t.getUTCDay() + 6) % 7) + 1,           // 1 = Monday ... 7 = Sunday
    };
  }

  // Midnight IST at the start of (today + days)
  function istMidnight(days = 0, from = new Date()) {
    const p = ist(from);
    return new Date(Date.UTC(p.y, p.mo - 1, p.d) - IST_MS + days * DAY);
  }

  // Start of the current hour, India time
  function startOfHour(from = new Date()) {
    const p = ist(from);
    return new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h) - IST_MS);
  }

  // "2026-10-22T18:00" (datetime-local input, meant as IST) -> Date
  function parseLocal(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || "");
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - IST_MS);
  }

  const pad = (n) => String(n).padStart(2, "0");
  function toInput(d) {
    if (!d) return "";
    const p = ist(d);
    return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
  }

  const fmts = {
    full: { weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
    dt: { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
    short: { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" },
    day: { weekday: "short", day: "2-digit", month: "short" },
    time: { hour: "2-digit", minute: "2-digit" },
    sec: { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" },
  };
  function fmt(d, style = "dt") {
    if (!d) return "—";
    return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...fmts[style] }).format(d);
  }

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const inr = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  window.SPU = { IST_MS, MIN, HOUR, DAY, ist, istMidnight, startOfHour, parseLocal, toInput, fmt, round2, inr, esc };
})();
