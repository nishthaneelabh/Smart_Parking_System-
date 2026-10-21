// Admin pages of the static demo.
(function () {
  const { esc, inr, fmt, toInput } = window.SPU;
  const E = window.SPDB, DB = E.DB;
  const A = window.SPAPP;
  const { route, go, act, badge, badgeColor, chargerLabel, details, onSubmit, countdown } = A;

  const NAV = [
    ["#/admin", "speedometer2", "Dashboard"], ["#/admin/concurrency", "people", "Concurrency demo"],
    ["#/admin/locations", "geo-alt", "Locations"], ["#/admin/slots", "p-square", "Parking slots"],
    ["#/admin/chargers", "ev-station", "Chargers"], ["#/admin/reservations", "calendar-check", "Reservations"],
    ["#/admin/waiting-list", "hourglass-split", "Waiting list"], ["#/admin/payments", "receipt", "Payments"],
    ["#/admin/pricing", "tags", "Pricing & policy"], ["#/admin/audit", "journal-text", "Audit log"],
  ];
  function layout(active, body) {
    return `<div class="container-fluid px-lg-4 py-3"><div class="row g-4">
      <aside class="col-lg-2"><div class="sp-card p-2 sp-admin-nav"><div class="small text-uppercase sp-muted px-2 pt-1 pb-2 fw-semibold">Admin</div>
        <nav class="nav flex-column">${NAV.map(([h, i, l]) => `<a class="nav-link ${h === active ? "active" : ""}" href="${h}"><i class="bi bi-${i}"></i> ${esc(l)}</a>`).join("")}</nav></div></aside>
      <section class="col-lg-10">${body}</section></div></div>`;
  }
  const opt = (v, l, sel) => `<option value="${esc(v)}" ${String(v) === String(sel ?? "") ? "selected" : ""}>${esc(l)}</option>`;
  const table = (head, rows, emptyMsg = "Nothing here.") => `<div class="table-responsive"><table class="table table-hover mb-0 small">
    <thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${head.length}" class="text-center sp-muted py-4">${emptyMsg}</td></tr>`}</tbody></table></div>`;

  // ======================================================== DASHBOARD
  route(/^\/admin$/, () => {
    const R = DB.reservations;
    const count = (st) => R.filter((r) => r.status === st).length;
    const revenue = DB.payments.filter((p) => p.status === "SUCCESS").reduce((a, p) => a + p.amount, 0);
    const tiles = [
      [`${DB.slots.filter((s) => s.occupancy_status === "OCCUPIED").length} / ${DB.slots.filter((s) => s.is_active).length}`, "Slots occupied now", "p-square", "blue"],
      [count("CONFIRMED"), "Confirmed upcoming", "calendar-check", ""], [count("HELD"), "Temporary holds", "lock", "amber"],
      [DB.waitingList.filter((w) => w.status === "WAITING").length, "Waiting in queue", "hourglass-split", "amber"],
      [`${DB.chargers.filter((c) => c.status === "FAULTY").length} / ${DB.chargers.length}`, "Faulty chargers", "exclamation-triangle", "red"],
      [inr(revenue), "Revenue collected", "currency-rupee", "blue"], [inr(R.reduce((a, r) => a + r.overstay_fine, 0)), "Overstay fines", "alarm", "red"],
      [DB.users.filter((u) => u.role === "USER").length, "Registered drivers", "people", ""],
    ];
    const statuses = [...new Set(R.map((r) => r.status))].map((s) => [s, count(s)]).sort((a, b) => b[1] - a[1]);
    const byLoc = DB.locations.map((l) => {
      const slots = DB.slots.filter((s) => s.location_id === l.location_id && s.is_active);
      const ids = new Set(slots.map((s) => s.slot_id));
      const occ = slots.filter((s) => s.occupancy_status === "OCCUPIED").length;
      const resIds = new Set(R.filter((r) => ids.has(r.slot_id)).map((r) => r.reservation_id));
      return { ...l, slots: slots.length, occ, pct: slots.length ? Math.round(100 * occ / slots.length) : 0,
               upcoming: R.filter((r) => ids.has(r.slot_id) && ["HELD", "CONFIRMED"].includes(r.status)).length,
               revenue: DB.payments.filter((p) => resIds.has(p.reservation_id) && p.status === "SUCCESS").reduce((a, p) => a + p.amount, 0) };
    });
    return { title: "Admin Dashboard", html: layout("#/admin", `
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3"><h1 class="h3 fw-bold mb-0">Operations dashboard</h1>
        <button class="btn btn-outline-primary" id="run-jobs"><i class="bi bi-arrow-repeat"></i> Run scheduled jobs now</button></div>
      <div class="row g-3 mb-4">${tiles.map(([v, l, i, c]) => `<div class="col-6 col-xl-3"><div class="sp-card sp-stat h-100 d-flex gap-3 align-items-center">
        <div class="icon ${c}"><i class="bi bi-${i}"></i></div><div><div class="value">${v}</div><div class="label">${l}</div></div></div></div>`).join("")}</div>
      <div class="row g-4">
        <div class="col-xl-7"><div class="sp-card p-0"><div class="p-3 border-bottom fw-bold">Locations</div>
          ${table(["Location", "Occupancy now", "Upcoming", "Revenue"], byLoc.map((l) => `<tr><td><div class="fw-semibold">${esc(l.name)}</div><div class="sp-muted">${l.city}</div></td>
            <td style="min-width:160px"><div>${l.occ} / ${l.slots} (${l.pct}%)</div><div class="progress" style="height:6px"><div class="progress-bar bg-info" style="width:${l.pct}%"></div></div></td>
            <td>${l.upcoming}</td><td>${inr(l.revenue)}</td></tr>`))}</div></div>
        <div class="col-xl-5">
          <div class="sp-card p-3 mb-4"><div class="fw-bold mb-2">Reservations by status</div>
            ${statuses.map(([s, n]) => `<div class="d-flex align-items-center gap-2 mb-2"><div style="width:110px">${badge(s)}</div>
              <div class="progress flex-grow-1" style="height:8px"><div class="progress-bar bg-${badgeColor(s)}" style="width:${Math.round(100 * n / R.length)}%"></div></div>
              <div class="small fw-semibold" style="width:32px;text-align:right">${n}</div></div>`).join("")}</div>
          <div class="sp-card p-0"><div class="p-3 border-bottom d-flex justify-content-between"><span class="fw-bold">Recent activity (written by triggers)</span><a href="#/admin/audit" class="small">Audit log</a></div>
            <ul class="list-group list-group-flush small">${DB.audit.slice(-12).reverse().map((a) => `<li class="list-group-item d-flex justify-content-between">
              <span><code>${a.table_name}</code> #${a.record_id}: ${a.old_status || a.action} → <strong>${a.new_status}</strong></span><span class="sp-muted">${fmt(a.changed_at, "short")}</span></li>`).join("")}</ul></div>
        </div>
      </div>`),
    after() {
      document.getElementById("run-jobs").onclick = () => act(() => E.runExpiryJobs(), (r) =>
        `Scheduled jobs ran: ${r.expired_holds} hold(s) expired, ${r.no_shows} no-show(s), ${r.expired_waits} waiting entr(ies) expired, ${r.offers_made} waiting-list offer(s) made.`);
    } };
  }, "admin");

  // ======================================================== CONCURRENCY (recorded replay)
  route(/^\/admin\/concurrency$/, () => {
    const REC = window.RECORDED_CONCURRENCY;
    return { title: "Concurrency Demo", html: layout("#/admin/concurrency", `
      <h1 class="h3 fw-bold mb-1">Live double-booking test — recorded from PostgreSQL</h1>
      <div class="sp-recorded p-3 mb-3 small"><i class="bi bi-record-circle text-danger"></i> <strong>This is a replay of a real run, not a simulation.</strong>
        A browser has no database server and cannot open two real transactions, so this page plays back results recorded on
        <strong>${esc(REC.recorded_at)}</strong> (${esc(REC.environment)}) by <code>scripts/record_concurrency.py</code>.
        Run <code>python scripts/concurrency_demo.py</code> or the admin page of the full system to see it live.</div>
      <div class="row g-4">
        <div class="col-xl-4"><div class="sp-card p-4">
          <div class="mb-2 small"><strong>Slot:</strong> ${esc(REC.slot)}<br><strong>Time:</strong> ${esc(REC.window)}</div>
          <label class="form-label small" for="run-pick">Recorded run</label>
          <select class="form-select mb-3" id="run-pick">
            <option value="wait">FOR UPDATE (loser waits) — winner held lock ${REC.runs.wait.hold_seconds}s</option>
            <option value="nowait">FOR UPDATE NOWAIT (loser fails instantly)</option></select>
          <button class="btn btn-teal w-100 py-2" id="replay"><i class="bi bi-play-fill"></i> Replay</button>
          <div class="small mt-3"><div class="fw-bold mb-1">No-delay race, ${REC.race.rounds} rounds</div>
            User A won <strong>${REC.race.wins["User A"]}</strong>, User B won <strong>${REC.race.wins["User B"]}</strong>.
            Rounds with anything other than exactly one booking: <strong>${REC.race.rounds_with_not_exactly_one_success}</strong>.</div>
          <hr><div class="small"><div class="fw-bold mb-1">What protects the slot?</div><ol class="mb-0 ps-3">
            <li><code>SELECT … FROM parking_slots WHERE slot_id = $1 FOR UPDATE</code> — the second transaction must wait.</li>
            <li>After the lock, a fresh overlap check sees the first booking → <code>SLOT_UNAVAILABLE</code>.</li>
            <li>Last line of defence: <code>EXCLUDE USING gist (slot_id WITH =, booking_period WITH &amp;&amp;)</code>.</li></ol></div>
        </div></div>
        <div class="col-xl-8"><div id="replay-out" class="sp-card p-4 h-100"><div class="text-center sp-muted py-5">
          <i class="bi bi-people display-5 d-block mb-2 opacity-50"></i>Press <strong>Replay</strong> to watch the recorded race at its real speed.</div></div></div>
      </div>`),
    after() {
      const out = document.getElementById("replay-out");
      let timers = [];
      const card = (r) => `<div class="col-md-6"><div class="border rounded-3 p-3 h-100 ${r.ok ? "border-success bg-success-subtle" : "border-danger bg-danger-subtle"}">
        <div class="d-flex justify-content-between"><strong>${esc(r.label)} — ${esc(r.user)}</strong><span class="badge text-bg-${r.ok ? "success" : "danger"}">${r.ok ? "BOOKED" : "REJECTED"}</span></div>
        <div class="small mt-1">PostgreSQL backend pid <code>${r.backend_pid}</code></div><div class="small">Waited for lock: <strong>${r.waited_ms} ms</strong></div>
        ${r.ok ? `<div class="small">Reservation <strong>#${r.reservation_id}</strong> (HELD)</div>` : `<div class="small text-danger-emphasis"><code>${esc(r.error_code)}</code>: ${esc(r.error)}</div>`}</div></div>`;
      document.getElementById("replay").onclick = () => {
        timers.forEach(clearTimeout); timers = [];
        const run = window.RECORDED_CONCURRENCY.runs[document.getElementById("run-pick").value];
        out.innerHTML = `<div class="fw-bold mb-2">Timeline (ms since start) <span class="badge text-bg-warning">replaying recorded run</span></div><div class="sp-timeline" id="tl"></div><div id="verdict"></div>`;
        const tl = document.getElementById("tl");
        run.events.forEach((e) => timers.push(setTimeout(() => {
          tl.insertAdjacentHTML("beforeend", `<div class="ev ${e.who === "User A" ? "row-a" : "row-b"}"><span class="text-muted">${e.t_ms.toFixed(1).padStart(7, " ")} ms</span> · <strong>${esc(e.who)}</strong> · ${esc(e.msg)}</div>`);
        }, e.t_ms)));
        const last = Math.max(...run.events.map((e) => e.t_ms)) + 300;
        timers.push(setTimeout(() => {
          document.getElementById("verdict").innerHTML = `<div class="sp-verdict mt-3 mb-3 ${run.double_booking_prevented ? "bg-success-subtle border border-success" : "bg-danger-subtle border border-danger"}">
            <div class="h5 fw-bold mb-1"><i class="bi bi-shield-check"></i> ${run.double_booking_prevented ? "Double booking prevented" : "DOUBLE BOOKING"}</div>
            <div class="small">Successful bookings: <strong>${run.successful_bookings}</strong> · Active overlapping rows in <code>reservations</code>: <strong>${run.active_overlapping_rows}</strong> · Mode: <code>${esc(run.mode)}</code></div></div>
            <div class="row g-3">${run.results.map(card).join("")}</div>`;
        }, last));
      };
    } };
  }, "admin");

  // ======================================================== LOCATIONS
  route(/^\/admin\/locations$/, () => ({ title: "Locations", html: layout("#/admin/locations", `
    <h1 class="h3 fw-bold mb-3">Locations</h1><div class="row g-4">
      <div class="col-xl-8"><div class="sp-card p-0">${table(["#", "Name", "City", "Slots", "Status", ""], DB.locations.map((l) => `<tr>
        <td class="sp-muted">${l.location_id}</td><td><div class="fw-semibold">${esc(l.name)}</div><div class="sp-muted">${esc(l.address)}, ${l.pincode}</div></td>
        <td>${esc(l.city)}</td><td><a href="#/admin/slots?location_id=${l.location_id}">${DB.slots.filter((s) => s.location_id === l.location_id).length}</a></td>
        <td>${l.is_active ? '<span class="badge text-bg-success">OPEN</span>' : '<span class="badge text-bg-secondary">CLOSED</span>'}</td>
        <td class="text-end"><button class="btn btn-sm ${l.is_active ? "btn-outline-danger" : "btn-outline-success"}" data-toggle="${l.location_id}">${l.is_active ? "Close" : "Open"}</button></td></tr>`))}</div></div>
      <div class="col-xl-4"><form id="loc-form" class="sp-card p-4" novalidate><h2 class="h6 fw-bold mb-3">Add location</h2>
        <div class="mb-2"><label class="form-label small" for="l-name">Name</label><input class="form-control" id="l-name" name="name" required></div>
        <div class="mb-2"><label class="form-label small" for="l-addr">Address</label><input class="form-control" id="l-addr" name="address" required></div>
        <div class="row g-2 mb-3"><div class="col-7"><label class="form-label small" for="l-city">City</label><input class="form-control" id="l-city" name="city" required></div>
          <div class="col-5"><label class="form-label small" for="l-pin">PIN code</label><input class="form-control" id="l-pin" name="pincode" pattern="[1-9][0-9]{5}" required></div></div>
        <button class="btn btn-primary w-100">Add location</button></form></div></div>`),
    after() {
      onSubmit("#loc-form", (d) => act(() => E.addLocation(d), "Location added."));
      document.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = () => {
        const l = E.location(b.dataset.toggle);
        if (confirm(l.is_active ? "Close this location for new bookings?" : "Re-open this location?"))
          act(() => { l.is_active = !l.is_active; return l.is_active; }, (on) => on ? "Location re-opened." : "Location closed for new bookings.");
      });
    } }), "admin");

  // ======================================================== SLOTS
  route(/^\/admin\/slots$/, (m, params) => {
    const loc = params.location_id ? Number(params.location_id) : null;
    const rows = DB.slots.filter((s) => !loc || s.location_id === loc)
      .sort((a, b) => a.location_id - b.location_id || b.slot_type.localeCompare(a.slot_type) || a.slot_code.localeCompare(b.slot_code));
    return { title: "Parking slots", html: layout("#/admin/slots", `
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3"><h1 class="h3 fw-bold mb-0">Parking slots</h1>
        <select class="form-select w-auto" id="slot-loc"><option value="">All locations</option>${DB.locations.map((l) => opt(l.location_id, l.name, loc)).join("")}</select></div>
      <div class="alert alert-light border small"><strong>Physical status</strong> (FREE / OCCUPIED) changes only on check-in / check-out (trigger B). A slot with future bookings is still FREE right now.</div>
      <div class="row g-4"><div class="col-xl-8"><div class="sp-card p-0">${table(["Slot", "Location", "Type", "Charger", "Physical now", "Upcoming", ""], rows.map((s) => {
        const c = E.chargerOfSlot(s.slot_id);
        const up = DB.reservations.filter((r) => r.slot_id === s.slot_id && E.ACTIVE.includes(r.status) && r.end_time > new Date());
        const next = up.filter((r) => r.start_time > new Date()).sort((a, b) => a.start_time - b.start_time)[0];
        return `<tr class="${s.is_active ? "" : "opacity-50"}"><td class="fw-semibold">${s.slot_code}<div class="sp-muted">#${s.slot_id} · floor ${s.floor_level}</div></td>
          <td>${esc(E.location(s.location_id).name)}</td><td>${s.slot_type} · ${s.size_class}</td>
          <td>${c ? chargerLabel(c.charger_type, c.power_kw, c.connector_type) + (c.status === "FAULTY" ? " " + badge("FAULTY") : "") : '<span class="sp-muted">—</span>'}</td>
          <td>${badge(s.occupancy_status)}</td><td>${up.length}${next ? `<div class="sp-muted">next ${fmt(next.start_time, "short")}</div>` : ""}</td>
          <td class="text-end"><button class="btn btn-sm ${s.is_active ? "btn-outline-secondary" : "btn-outline-success"}" data-slot="${s.slot_id}">${s.is_active ? "Disable" : "Enable"}</button></td></tr>`; }))}</div></div>
      <div class="col-xl-4"><form id="slot-form" class="sp-card p-4" novalidate><h2 class="h6 fw-bold mb-3">Add slot</h2>
        <div class="mb-2"><label class="form-label small" for="a-loc">Location</label><select class="form-select" id="a-loc" name="location_id">${DB.locations.map((l) => opt(l.location_id, l.name, loc)).join("")}</select></div>
        <div class="row g-2 mb-2"><div class="col-6"><label class="form-label small" for="a-code">Slot code</label><input class="form-control" id="a-code" name="slot_code" maxlength="10" required></div>
          <div class="col-6"><label class="form-label small" for="a-floor">Floor</label><input class="form-control" id="a-floor" name="floor_level" type="number" min="-5" max="20" value="0"></div></div>
        <div class="row g-2 mb-2"><div class="col-6"><label class="form-label small" for="a-type">Type</label>
            <select class="form-select" id="a-type" name="slot_type" onchange="document.getElementById('ev-fields').classList.toggle('d-none', this.value !== 'EV')"><option value="REGULAR">Regular</option><option value="EV">EV</option></select></div>
          <div class="col-6"><label class="form-label small" for="a-size">Size</label><select class="form-select" id="a-size" name="size_class"><option>CAR</option><option>SUV</option><option>BIKE</option></select></div></div>
        <div id="ev-fields" class="d-none border rounded-3 p-2 mb-2"><div class="small fw-semibold mb-1">Charger (added together with the slot)</div><div class="row g-2">
          <div class="col-6"><select class="form-select form-select-sm" name="charger_type"><option>AC</option><option>DC</option></select></div>
          <div class="col-6"><input class="form-control form-control-sm" name="power_kw" type="number" step="0.1" min="1" max="350" value="7.4"></div>
          <div class="col-12"><select class="form-select form-select-sm" name="connector_type"><option value="TYPE2">Type 2 (AC)</option><option value="BHARAT_AC001">Bharat AC-001 (AC)</option>
            <option value="CCS2">CCS2 (DC)</option><option value="CHADEMO">CHAdeMO (DC)</option></select></div></div></div>
        <button class="btn btn-primary w-100 mt-2">Add slot</button></form></div></div>`),
    after() {
      document.getElementById("slot-loc").onchange = (e) => go("#/admin/slots" + (e.target.value ? "?location_id=" + e.target.value : ""));
      onSubmit("#slot-form", (d) => act(() => E.addSlot(d), "Slot added."));
      document.querySelectorAll("[data-slot]").forEach((b) => b.onclick = () => act(() => {
        const s = E.slot(b.dataset.slot); s.is_active = !s.is_active; return s.is_active;
      }, (on) => on ? "Slot re-opened for bookings." : "Slot closed for NEW bookings (existing bookings are kept)."));
    } };
  }, "admin");

  // ======================================================== CHARGERS
  route(/^\/admin\/chargers$/, () => {
    const rows = [...DB.chargers].sort((a, b) => (b.status === "FAULTY") - (a.status === "FAULTY") || a.charger_id - b.charger_id);
    const tickets = [...DB.maintenance].sort((a, b) => b.reported_at - a.reported_at);
    return { title: "Chargers", html: layout("#/admin/chargers", `
      <h1 class="h3 fw-bold mb-1">EV chargers</h1>
      <p class="sp-muted">Marking a charger <strong>FAULTY</strong> fires trigger C: upcoming bookings on it are cancelled with a full refund and the drivers go to the front of the waiting list (priority 4).
        Marking it <strong>repaired</strong> closes the ticket and immediately processes the waiting list.</p>
      <div class="sp-card p-0 mb-4">${table(["#", "Location / slot", "Charger", "Status", "Upcoming", "Action"], rows.map((c) => {
        const s = E.slot(c.slot_id), l = E.location(s.location_id);
        const open = DB.maintenance.find((m) => m.charger_id === c.charger_id && !m.resolved_at);
        const up = DB.reservations.filter((r) => r.slot_id === c.slot_id && ["HELD", "CONFIRMED"].includes(r.status) && r.end_time > new Date()).length;
        return `<tr class="${c.status === "FAULTY" ? "table-danger" : ""}"><td>${c.charger_id}</td><td><div class="fw-semibold">${esc(l.name)}</div><div class="sp-muted">Slot ${s.slot_code} · ${l.city}</div></td>
          <td>${chargerLabel(c.charger_type, c.power_kw, c.connector_type)}</td>
          <td>${badge(c.status)}${open ? `<div class="text-danger">${esc(open.issue_description)}</div><div class="sp-muted">since ${fmt(open.reported_at, "short")}</div>` : ""}</td><td>${up}</td>
          <td style="min-width:280px">${c.status === "OPERATIONAL"
            ? `<form class="d-flex gap-1" data-faulty="${c.charger_id}" data-up="${up}"><input class="form-control form-control-sm" name="issue" placeholder="Describe the fault" required>
                 <button class="btn btn-sm btn-danger text-nowrap"><i class="bi bi-exclamation-triangle"></i> Faulty</button></form>`
            : `<form class="d-flex gap-1" data-repair="${c.charger_id}"><input class="form-control form-control-sm" name="note" placeholder="Repair note">
                 <button class="btn btn-sm btn-success text-nowrap"><i class="bi bi-wrench"></i> Repaired</button></form>`}</td></tr>`; }))}</div>
      <div class="sp-card p-0"><div class="p-3 border-bottom fw-bold">Maintenance tickets</div>${table(["#", "Charger", "Issue", "Reported", "Resolved", "Note"], tickets.map((t) => {
        const c = E.charger(t.charger_id), s = E.slot(c.slot_id);
        return `<tr><td>${t.maintenance_id}</td><td>#${c.charger_id} · ${esc(E.location(s.location_id).name)} ${s.slot_code}</td><td>${esc(t.issue_description)}</td>
          <td>${fmt(t.reported_at, "short")}</td><td>${t.resolved_at ? fmt(t.resolved_at, "short") : '<span class="badge text-bg-danger">OPEN</span>'}</td><td>${esc(t.resolution_note || "")}</td></tr>`; }))}</div>`),
    after() {
      document.querySelectorAll("form[data-faulty]").forEach((f) => f.dataset.confirm =
        `Mark charger #${f.dataset.faulty} FAULTY? ${f.dataset.up} upcoming booking(s) will be cancelled and refunded.`);
      onSubmit("form[data-faulty]", (d, f) => act(() => E.markChargerFaulty(f.dataset.faulty, d.issue, A.state.userId),
        (n) => `Charger #${f.dataset.faulty} marked FAULTY. ${n} upcoming booking(s) were cancelled, refunded and moved to the front of the waiting list.`));
      onSubmit("form[data-repair]", (d, f) => act(() => E.markChargerRepaired(f.dataset.repair, d.note),
        (n) => `Charger #${f.dataset.repair} repaired — it can be booked again. Waiting list processed: ${n} offer(s) made.`));
    } };
  }, "admin");

  // ======================================================== RESERVATIONS
  route(/^\/admin\/reservations$/, (m, params) => {
    const st = params.status || "", loc = params.location_id ? Number(params.location_id) : null;
    const rows = DB.reservations.map(details).filter((r) => (!st || r.status === st) && (!loc || r.location_id === loc)).sort((a, b) => b.start_time - a.start_time);
    return { title: "Reservations", html: layout("#/admin/reservations", `
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3"><h1 class="h3 fw-bold mb-0">Reservations</h1>
        <div class="d-flex gap-2"><select class="form-select" id="f-status"><option value="">All statuses</option>${["HELD", "CONFIRMED", "CHECKED_IN", "COMPLETED", "CANCELLED", "EXPIRED", "NO_SHOW"].map((s) => opt(s, s, st)).join("")}</select>
          <select class="form-select" id="f-loc"><option value="">All locations</option>${DB.locations.map((l) => opt(l.location_id, l.name, loc)).join("")}</select></div></div>
      <div class="sp-card p-0">${table(["#", "Driver", "Slot", "Period", "Status", "Source", "Total", "Actions"], rows.map((r) => `<tr>
        <td><a href="#/reservation/${r.reservation_id}">${r.reservation_id}</a></td><td>${esc(r.full_name)}<div class="sp-muted">${r.registration_no}</div></td>
        <td>${esc(r.location_name)}<div class="sp-muted">${r.slot_code}${r.charger_type ? " · " + r.charger_type : ""}</div></td>
        <td>${fmt(r.start_time, "short")} → ${fmt(r.end_time, "time")}</td>
        <td>${badge(r.status)}${r.overstay_fine > 0 ? `<div class="text-danger">fine ${inr(r.overstay_fine)}</div>` : ""}</td><td>${r.source}</td><td>${inr(r.total_amount)}</td>
        <td class="text-end text-nowrap">${r.status === "CONFIRMED" ? `<button class="btn btn-sm btn-outline-info" data-checkin="${r.reservation_id}">Check in</button>` : ""}
          ${r.status === "CHECKED_IN" ? `<a class="btn btn-sm btn-outline-info" href="#/reservation/${r.reservation_id}">Check out…</a>` : ""}
          ${["HELD", "CONFIRMED"].includes(r.status) ? `<button class="btn btn-sm btn-outline-danger" data-cancel="${r.reservation_id}">Cancel</button>` : ""}</td></tr>`), "No reservations match.")}</div>`),
    after() {
      const refilter = () => {
        const q = new URLSearchParams();
        const s = document.getElementById("f-status").value, l = document.getElementById("f-loc").value;
        if (s) q.set("status", s); if (l) q.set("location_id", l);
        go("#/admin/reservations" + (q.toString() ? "?" + q : ""));
      };
      document.getElementById("f-status").onchange = refilter;
      document.getElementById("f-loc").onchange = refilter;
      document.querySelectorAll("[data-checkin]").forEach((b) => b.onclick = () => act(() => E.checkIn(b.dataset.checkin, A.state.userId, true), "Checked in. Slot marked OCCUPIED (trigger B)."));
      document.querySelectorAll("[data-cancel]").forEach((b) => b.onclick = () => {
        if (confirm(`Cancel reservation #${b.dataset.cancel} and refund it?`))
          act(() => E.cancelReservation(b.dataset.cancel, A.state.userId, true, "Cancelled by admin"), (refund) => `Reservation cancelled. Refund: ${inr(refund)}. Waiting list processed.`);
      });
    } };
  }, "admin");

  // ======================================================== WAITING LIST
  route(/^\/admin\/waiting-list$/, () => {
    const rows = E.waitingQueue().sort((a, b) => (b.status === "WAITING") - (a.status === "WAITING") || b.priority - a.priority || a.requested_at - b.requested_at || a.entry_id - b.entry_id);
    return { title: "Waiting list", html: layout("#/admin/waiting-list", `
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3"><h1 class="h3 fw-bold mb-0">Waiting list</h1>
        <button class="btn btn-primary" id="process"><i class="bi bi-play-fill"></i> Process queue now</button></div>
      <div class="alert alert-light border small">Queue order = <code>ORDER BY priority DESC, requested_at ASC, entry_id ASC</code>.
        Priority: 4 service recovery (charger fault) · 3 accessibility permit · 2 premium · 1 standard.</div>
      <div class="sp-card p-0">${table(["Pos.", "#", "Driver", "Request", "Priority", "Requested at", "Status", "Offer"], rows.map((e) => `<tr class="${e.status === "OFFERED" ? "table-info" : ""}">
        <td class="fw-bold">${e.queue_position || ""}</td><td>${e.entry_id}</td><td>${esc(e.full_name)}<div class="sp-muted">${e.registration_no}</div></td>
        <td>${esc(e.location_name)} · ${e.slot_type}${e.charger_type ? " " + e.charger_type : ""}<div class="sp-muted">${fmt(e.start_time, "short")} → ${fmt(e.end_time, "time")}</div></td>
        <td><span class="badge text-bg-light border">${e.priority} · ${e.priority_label}</span></td><td>${fmt(e.requested_at, "sec")}</td><td>${badge(e.status)}</td>
        <td>${e.offered_reservation_id ? `<a href="#/reservation/${e.offered_reservation_id}">#${e.offered_reservation_id}</a>${e.status === "OFFERED" ? `<div class="sp-muted">expires ${countdown(e.offer_expires_at, false)}</div>` : ""}` : ""}</td></tr>`), "The waiting list is empty.")}</div>`),
    after() { document.getElementById("process").onclick = () => act(() => E.processWaitingList(), (n) => `Waiting list processed: ${n} offer(s) made.`); } };
  }, "admin");

  // ======================================================== PAYMENTS
  route(/^\/admin\/payments$/, () => {
    const P = [...DB.payments].sort((a, b) => b.paid_at - a.paid_at);
    const sum = (st) => P.filter((p) => p.status === st).reduce((a, p) => a + p.amount, 0);
    return { title: "Payments", html: layout("#/admin/payments", `
      <h1 class="h3 fw-bold mb-3">Payments <span class="badge text-bg-warning fs-6 align-middle">simulated</span></h1>
      <div class="row g-3 mb-3"><div class="col-md-4"><div class="sp-card sp-stat"><div class="value">${inr(sum("SUCCESS"))}</div><div class="label">Collected</div></div></div>
        <div class="col-md-4"><div class="sp-card sp-stat"><div class="value">${inr(sum("REFUNDED"))}</div><div class="label">Refunded</div></div></div>
        <div class="col-md-4"><div class="sp-card sp-stat"><div class="value">${P.filter((p) => p.status === "FAILED").length}</div><div class="label">Failed attempts</div></div></div></div>
      <div class="sp-card p-0">${table(["#", "Transaction", "Reservation", "Driver", "Type", "Method", "Status", "Paid at", "Amount"], P.map((p) => {
        const d = details(E.reservation(p.reservation_id));
        return `<tr><td>${p.payment_id}</td><td><code>${p.transaction_ref}</code></td><td><a href="#/reservation/${p.reservation_id}">#${p.reservation_id}</a> <span class="sp-muted">${esc(d.location_name)} ${d.slot_code}</span></td>
          <td>${esc(d.full_name)}</td><td>${p.payment_type}</td><td>${p.method}</td><td>${badge(p.status)}</td><td>${fmt(p.paid_at, "short")}</td><td class="fw-semibold">${inr(p.amount)}</td></tr>`; }))}</div>`) };
  }, "admin");

  // ======================================================== PRICING
  route(/^\/admin\/pricing$/, () => {
    const pol = DB.policy;
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    return { title: "Pricing & policy", html: layout("#/admin/pricing", `
      <h1 class="h3 fw-bold mb-1">Pricing &amp; policy</h1>
      <p class="sp-muted">Rates live in tables (<code>pricing_rules</code>, <code>peak_hours</code>, <code>booking_policy</code>); new bookings use changes immediately. Existing bookings keep their price.</p>
      <div class="row g-4"><div class="col-xl-7"><div class="sp-card p-0"><div class="p-3 border-bottom fw-bold">Hourly rates (₹)</div>
        ${table(["Applies to", "Location", "Description", "Rate / hour"], DB.pricingRules.map((r) => `<tr>
          <td><span class="badge ${r.applies_to === "DC" ? "text-bg-danger" : r.applies_to === "AC" ? "text-bg-info" : "text-bg-primary"}">${r.applies_to}</span></td>
          <td>${r.location_id ? esc(E.location(r.location_id).name) : "All locations (default)"}</td><td class="sp-muted">${esc(r.description)}</td>
          <td><form class="d-flex gap-1" data-rule="${r.rule_id}"><div class="input-group input-group-sm"><span class="input-group-text">₹</span>
            <input class="form-control" name="rate" type="number" min="0" step="0.5" value="${r.rate_per_hour}" required></div><button class="btn btn-sm btn-outline-primary">Save</button></form></td></tr>`))}</div></div>
      <div class="col-xl-5"><div class="sp-card p-0 mb-4"><div class="p-3 border-bottom fw-bold">Peak hours (India time)</div>
        ${table(["Window", "Days", "Multiplier"], DB.peakHours.map((p) => `<tr><td>${esc(p.label)}<div class="sp-muted">${hhmm(p.start_min)}–${hhmm(p.end_min)}</div></td><td>${p.day_type}</td>
          <td><form class="d-flex gap-1" data-peak="${p.peak_id}"><input class="form-control form-control-sm" name="multiplier" type="number" min="1" max="5" step="0.05" value="${p.multiplier}" required>
            <button class="btn btn-sm btn-outline-primary">Save</button></form></td></tr>`))}</div>
        <div class="sp-card p-3 small"><div class="fw-bold mb-2">Booking policy</div><ul class="mb-0">
          <li>Temporary hold: <strong>${pol.hold_minutes} min</strong> to pay</li><li>Waiting-list offer window: <strong>${pol.waitlist_offer_minutes} min</strong></li>
          <li>Overstay grace: <strong>${pol.grace_minutes} min</strong>, then <strong>${pol.overstay_multiplier}×</strong> parking rate per started hour</li>
          <li>No-show after <strong>${pol.no_show_minutes} min</strong> without check-in</li><li>Check-in opens <strong>${pol.early_checkin_minutes} min</strong> early</li>
          <li>Booking length: ${pol.min_booking_minutes} min – ${pol.max_booking_hours} h, up to ${pol.max_advance_days} days ahead</li></ul></div></div></div>`),
    after() {
      onSubmit("form[data-rule]", (d, f) => act(() => {
        const v = Number(d.rate); if (!(v >= 0)) throw new E.DemoError("INVALID_INPUT", "Rate must be a non-negative number");
        DB.pricingRules.find((r) => r.rule_id === Number(f.dataset.rule)).rate_per_hour = v;
      }, "Rate updated. New bookings use it immediately."));
      onSubmit("form[data-peak]", (d, f) => act(() => {
        const v = Number(d.multiplier); if (!(v >= 1 && v <= 5)) throw new E.DemoError("INVALID_INPUT", "Multiplier must be between 1 and 5 (CHECK constraint)");
        DB.peakHours.find((p) => p.peak_id === Number(f.dataset.peak)).multiplier = v;
      }, "Peak multiplier updated."));
    } };
  }, "admin");

  // ======================================================== AUDIT
  route(/^\/admin\/audit$/, () => ({ title: "Audit log", html: layout("#/admin/audit", `
    <h1 class="h3 fw-bold mb-1">Audit log</h1><p class="sp-muted">Every status change on reservations, chargers, waiting-list entries and payments — written by the audit trigger.</p>
    <div class="sp-card p-0">${table(["#", "When", "Table", "Record", "Action", "Old → New", "Details"], [...DB.audit].reverse().slice(0, 300).map((a) => `<tr>
      <td>${a.log_id}</td><td class="text-nowrap">${fmt(a.changed_at, "sec")}</td><td><code>${a.table_name}</code></td><td>${a.record_id}</td><td>${a.action}</td>
      <td>${a.old_status || "∅"} → <strong>${a.new_status}</strong></td><td class="sp-muted">${esc(a.details)}</td></tr>`))}</div>`) }), "admin");
})();
