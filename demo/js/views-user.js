// User-facing pages of the static demo (mirror the Flask templates).
(function () {
  const { esc, inr, fmt, toInput, parseLocal, startOfHour, HOUR, DAY } = window.SPU;
  const E = window.SPDB, DB = E.DB;
  const A = window.SPAPP;
  const { route, go, flash, act, badge, slotIcon, chargerLabel, empty, countdown, details, onSubmit, currentUser, isAdmin } = A;

  const defaultWindow = () => { const s = new Date(startOfHour().getTime() + HOUR); return [s, new Date(s.getTime() + 2 * HOUR)]; };
  const myVehicles = () => DB.vehicles.filter((v) => v.user_id === A.state.userId);
  const opt = (value, label, selected) => `<option value="${esc(value)}" ${String(selected) === String(value) ? "selected" : ""}>${esc(label)}</option>`;

  // ======================================================== HOME
  route(/^\/$/, () => {
    const stats = [
      [DB.locations.filter((l) => l.is_active).length, "Locations", "geo-alt"],
      [DB.slots.filter((s) => s.is_active).length, "Parking slots", "p-square"],
      [DB.chargers.filter((c) => c.status === "OPERATIONAL").length, "Working chargers", "ev-station"],
      [new Set(DB.locations.map((l) => l.city)).size, "Cities", "buildings"],
    ];
    const features = [
      ["shield-lock", "No double bookings", "Each booking locks the slot row (SELECT … FOR UPDATE) and a PostgreSQL EXCLUDE constraint rejects any overlapping reservation."],
      ["ev-station", "EV charger matching", "Only chargers that fit your car’s connector (CCS2, Type 2, CHAdeMO, Bharat AC-001) and are working are offered."],
      ["graph-up-arrow", "Dynamic pricing", "Peak-hour multipliers and AC / DC fast-charging rates come from configurable tables, applied per 15 minutes."],
      ["hourglass-split", "Priority waiting list", "Full? Join the queue. Higher priority first, then first-come-first-served, with a 10-minute offer when a slot frees up."],
      ["lightning-charge", "Automatic updates", "Triggers mark slots occupied, calculate overstay fines and cancel bookings on faulty chargers."],
      ["clock-history", "Holds that expire", "Unpaid holds are released automatically so slots are never blocked by abandoned bookings."],
    ];
    return { title: "Home", html: `
      <section class="sp-hero py-5 mb-5"><div class="container py-lg-4"><div class="row align-items-center g-4">
        <div class="col-lg-7 sp-fade-in">
          <span class="badge rounded-pill text-bg-light text-uppercase mb-3">Real-time · No double bookings</span>
          <h1 class="display-5 mb-3">Smart Parking &amp; EV Charging, reserved in seconds.</h1>
          <p class="lead mb-4">Find a parking space or a compatible EV charger, lock it with a safe database transaction,
            and pay — even when hundreds of drivers are booking at the same moment.</p>
          <div class="sp-flow mb-4">${["search Search", "shield-check Check", "lock Reserve", "car-front Use", "receipt Complete"]
            .map((x) => { const [i, ...t] = x.split(" "); return `<span><i class="bi bi-${i}"></i> ${t.join(" ")}</span>`; }).join('<i class="bi bi-arrow-right"></i>')}</div>
          ${currentUser() ? `<a href="#/book" class="btn btn-teal btn-lg me-2"><i class="bi bi-search"></i> Find a slot</a>
                             <a href="#/dashboard" class="btn btn-outline-light btn-lg">My dashboard</a>`
                          : `<a href="#/login" class="btn btn-teal btn-lg me-2">Try a demo account</a>
                             <a href="#/about" class="btn btn-outline-light btn-lg">About this demo</a>`}
        </div>
        <div class="col-lg-5"><div class="row g-3">${stats.map(([v, l, i]) => `<div class="col-6"><div class="sp-card sp-stat text-dark h-100">
          <div class="icon mb-2"><i class="bi bi-${i}"></i></div><div class="value">${v}</div><div class="label">${l}</div></div></div>`).join("")}</div></div>
      </div></div></section>
      <section class="container">
        <h2 class="sp-section-title h4 mb-3">Why this system is reliable</h2>
        <div class="row g-3 mb-5">${features.map(([i, t, d]) => `<div class="col-md-6 col-lg-4"><div class="sp-card sp-card-hover p-4 h-100">
          <div class="sp-slot-icon sp-ev mb-3"><i class="bi bi-${i}"></i></div><h3 class="h6 fw-bold">${t}</h3>
          <p class="sp-muted small mb-0">${d}</p></div></div>`).join("")}</div>
        <div class="sp-card p-4 mb-4"><div class="row align-items-center g-3">
          <div class="col-md-8"><h2 class="h5 fw-bold mb-1">See the double-booking test</h2>
            <p class="sp-muted mb-0">Log in as the admin and open <em>Concurrency demo</em> to replay a real run from PostgreSQL.</p></div>
          <div class="col-md-4 text-md-end"><a href="#/locations" class="btn btn-primary"><i class="bi bi-geo-alt"></i> View locations</a></div>
        </div></div>
      </section>` };
  });

  // ======================================================== ABOUT
  route(/^\/about$/, () => ({ title: "About this demo", html: `
    <div class="container py-3" style="max-width:900px">
      <h1 class="h3 fw-bold mb-3">About this demo</h1>
      <div class="sp-card p-4 mb-3">
        <p>This website is a <strong>browser-only demonstration</strong> of our DBMS project
          <em>Smart Parking &amp; EV Charging Reservation System</em>. It needs no server: all data is created in your browser
          when the page loads, and <strong>every change is reset when you refresh</strong>.</p>
        <p class="mb-0">The real project runs on <strong>PostgreSQL + Flask</strong>. There, every rule below is enforced by the database
          itself. In this demo the same rules are re-implemented in JavaScript (<code>js/engine.js</code>) so you can click through every feature.</p>
      </div>
      <div class="sp-card p-0 mb-3"><div class="table-responsive"><table class="table mb-0">
        <thead><tr><th>Feature</th><th>PostgreSQL version (evaluated)</th><th>This browser demo</th></tr></thead>
        <tbody>
          <tr><td>Data storage</td><td>13 normalized tables, constraints, persistent</td><td>JavaScript arrays, reset on refresh</td></tr>
          <tr><td>Double-booking prevention</td><td><code>SELECT … FOR UPDATE</code> + <code>EXCLUDE USING gist</code></td><td>Same overlap rule, checked in JS</td></tr>
          <tr><td>Concurrent users</td><td>Real separate connections — proven by tests</td><td><strong>Cannot be simulated honestly</strong> — the Concurrency page <em>replays a recorded real run</em></td></tr>
          <tr><td>Triggers A, B, C</td><td>PL/pgSQL triggers</td><td>Same logic, run on each status change</td></tr>
          <tr><td>Pricing, waiting list, expiry</td><td>PL/pgSQL functions, pg_cron / Python scheduler</td><td>Ported functions, scheduler runs every 15 s</td></tr>
          <tr><td>Passwords</td><td>scrypt hashes</td><td>Demo only — kept in memory as typed</td></tr>
        </tbody></table></div></div>
      <div class="sp-card p-4">
        <ul class="mb-0">
          <li>Source code, SQL, report and tests: <a href="${A.REPO_URL}" target="_blank" rel="noopener">${A.REPO_URL}</a></li>
          <li>Engine self-test (same expected values as the PostgreSQL test suite): <a href="selftest.html">selftest.html</a></li>
          <li>Data is <strong>never sent anywhere</strong> — there is no server.</li>
        </ul>
      </div>
    </div>` }));

  // ======================================================== LOGIN / REGISTER
  const DEMO_NOTES = {
    "admin@smartpark.in": "Manage slots, chargers, run the concurrency demo",
    "rohan.sharma@example.in": "Premium · Nexon EV + Honda City · has bookings",
    "arjun.mehta@example.in": "Accessibility permit · top of the waiting list",
    "meera.pillai@example.in": "Has a paid overstay fine · waiting for DC charger",
    "vikram.singh@example.in": "Premium · Fortuner SUV · unpaid overstay fine",
    "divya.krishnan@example.in": "Has an active 10-minute hold to pay",
    "rahul.verma@example.in": "Currently checked in (slot occupied)",
    "demo.a@example.in": "Clean account with an EV — try booking",
    "demo.b@example.in": "Second clean EV account",
  };
  function finishLogin(u, params) {
    A.state.userId = u.user_id;
    flash(`Welcome back, ${u.full_name.split(" ")[0]}!`);
    const next = params.next && params.next.startsWith("#/") ? params.next : null;
    go(next || (u.role === "ADMIN" ? "#/admin" : "#/dashboard"));
  }
  route(/^\/login$/, (m, params) => {
    const demos = Object.keys(DEMO_NOTES).map((email) => DB.users.find((u) => u.email === email)).filter(Boolean);
    return { title: "Log in", html: `
    <div class="container py-4"><div class="row justify-content-center g-4">
      <div class="col-lg-5"><div class="sp-card p-4 p-md-5 sp-fade-in">
        <h1 class="h4 fw-bold mb-1">Welcome back</h1><p class="sp-muted mb-4">Log in to reserve parking and EV chargers.</p>
        <form id="login-form" novalidate>
          <div class="mb-3"><label class="form-label" for="email">Email</label>
            <input type="email" class="form-control" id="email" name="email" value="${esc(params.email || "")}" required></div>
          <div class="mb-4"><label class="form-label" for="password">Password</label>
            <input type="password" class="form-control" id="password" name="password" required></div>
          <button class="btn btn-primary w-100 py-2">Log in</button>
        </form>
        <p class="text-center mt-3 mb-0 small">New here? <a href="#/register">Create an account</a></p>
      </div></div>
      <div class="col-lg-7"><div class="sp-card p-4 sp-fade-in">
        <div class="d-flex justify-content-between align-items-start mb-1">
          <h2 class="h5 fw-bold mb-0"><i class="bi bi-people"></i> Quick demo login</h2><span class="badge text-bg-warning">sample data</span></div>
        <p class="sp-muted small mb-3">Click an account to log in as that person. Each one is set up to show a different part of the system.</p>
        <div class="row g-2">${demos.map((u) => `<div class="col-md-6">
          <button type="button" class="sp-demo-account w-100 h-100 text-start ${u.role === "ADMIN" ? "is-admin" : ""}" data-login="${u.user_id}">
            <div class="d-flex justify-content-between align-items-center gap-2"><span class="fw-semibold">${esc(u.full_name)}</span>
              ${u.role === "ADMIN" ? '<span class="badge text-bg-warning">ADMIN</span>' : u.has_accessibility_permit ? '<span class="badge text-bg-info">Priority 3</span>'
                : u.membership_tier === "PREMIUM" ? '<span class="badge text-bg-primary">Premium</span>' : '<span class="badge text-bg-light border">User</span>'}</div>
            <div class="small sp-muted text-truncate">${esc(u.email)}</div><div class="small mt-1">${esc(DEMO_NOTES[u.email])}</div>
          </button></div>`).join("")}</div>
        <div class="small sp-muted mt-3">Passwords: admin <code>Admin@123</code>, everyone else <code>Password@123</code>.</div>
      </div></div>
    </div></div>`,
    after() {
      onSubmit("#login-form", (d) => act(() => E.login(d.email, d.password), null, (u) => finishLogin(u, params)));
      document.querySelectorAll("[data-login]").forEach((b) => b.onclick = () => finishLogin(E.user(b.dataset.login), params));
    } };
  });

  const vehicleFields = (required) => `
    <div class="row g-3">
      <div class="col-md-4"><label class="form-label" for="registration_no">Registration number</label>
        <input class="form-control text-uppercase" id="registration_no" name="registration_no" placeholder="TN09AB1234" ${required ? "required" : ""}></div>
      <div class="col-md-4"><label class="form-label" for="model_name">Model</label>
        <input class="form-control" id="model_name" name="model_name" placeholder="Tata Nexon EV" ${required ? "required" : ""}></div>
      <div class="col-md-4"><label class="form-label" for="vehicle_type">Type</label>
        <select class="form-select" id="vehicle_type" name="vehicle_type"><option value="CAR">Car</option><option value="SUV">SUV</option><option value="BIKE">Bike</option></select></div>
      <div class="col-md-4 d-flex align-items-end"><div class="form-check form-switch mb-2">
        <input class="form-check-input" type="checkbox" role="switch" id="is_ev" name="is_ev"
               onchange="document.getElementById('connector-wrap').classList.toggle('d-none', !this.checked)">
        <label class="form-check-label" for="is_ev">Electric vehicle</label></div></div>
      <div class="col-md-8 d-none" id="connector-wrap"><label class="form-label" for="connector_type">Charging connector</label>
        <select class="form-select" id="connector_type" name="connector_type"><option value="">Choose…</option>
          <option value="CCS2">CCS2 (most new EVs — also works with Type 2 AC)</option><option value="TYPE2">Type 2 (AC only)</option>
          <option value="CHADEMO">CHAdeMO</option><option value="BHARAT_AC001">Bharat AC-001</option></select></div>
    </div>`;

  route(/^\/register$/, () => ({ title: "Sign up", html: `
    <div class="container py-4"><div class="row justify-content-center"><div class="col-lg-8"><div class="sp-card p-4 p-md-5 sp-fade-in">
      <h1 class="h4 fw-bold mb-1">Create your account</h1><p class="sp-muted mb-4">Demo account — it disappears when you refresh.</p>
      <form id="reg-form" novalidate>
        <div class="row g-3 mb-4">
          <div class="col-md-6"><label class="form-label" for="full_name">Full name</label><input class="form-control" id="full_name" name="full_name" minlength="2" required></div>
          <div class="col-md-6"><label class="form-label" for="phone">Mobile number</label><div class="input-group"><span class="input-group-text">+91</span>
            <input class="form-control" id="phone" name="phone" pattern="[6-9][0-9]{9}" maxlength="10" required></div></div>
          <div class="col-12"><label class="form-label" for="r-email">Email</label><input type="email" class="form-control" id="r-email" name="email" required></div>
          <div class="col-md-6"><label class="form-label" for="r-password">Password</label>
            <input type="password" class="form-control" id="r-password" name="password" minlength="8" required><div class="form-text">At least 8 characters, letters and numbers.</div></div>
          <div class="col-md-6"><label class="form-label" for="confirm_password">Confirm password</label><input type="password" class="form-control" id="confirm_password" name="confirm_password" required></div>
        </div>
        <h2 class="h6 text-uppercase sp-muted mb-3">Your vehicle <span class="text-lowercase fw-normal">(optional)</span></h2>
        ${vehicleFields(false)}
        <button class="btn btn-primary w-100 py-2 mt-4">Create account</button>
      </form>
    </div></div></div></div>`,
    after() {
      onSubmit("#reg-form", (d) => {
        if (d.password !== d.confirm_password) { flash("Passwords do not match.", "danger"); return A.render(); }
        act(() => E.register({ ...d, vehicle: d.registration_no ? d : null }), "Account created! Please log in.",
            () => go("#/login?email=" + encodeURIComponent(d.email.toLowerCase())));
      });
    } }));

  // ======================================================== DASHBOARD
  route(/^\/dashboard$/, () => {
    const u = currentUser();
    const mine = DB.reservations.filter((r) => r.user_id === u.user_id);
    const active = mine.filter((r) => E.ACTIVE.includes(r.status)).sort((a, b) => a.start_time - b.start_time).map(details);
    const queue = E.waitingQueue().filter((w) => w.user_id === u.user_id);
    const offers = queue.filter((w) => w.status === "OFFERED" && w.offer_expires_at > new Date());
    const waiting = queue.filter((w) => w.status === "WAITING");
    const spent = mine.filter((r) => ["COMPLETED", "CHECKED_IN", "CONFIRMED", "NO_SHOW"].includes(r.status)).reduce((a, r) => a + r.total_amount, 0);
    const stat = (icon, cls, value, label) => `<div class="col-6 col-lg-3"><div class="sp-card sp-stat h-100"><div class="icon ${cls} mb-2"><i class="bi bi-${icon}"></i></div>
      <div class="value">${value}</div><div class="label">${label}</div></div></div>`;
    return { title: "Dashboard", html: `<div class="container py-3">
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4">
        <div><h1 class="h3 fw-bold mb-0">Hello, ${esc(u.full_name.split(" ")[0])} 👋</h1>
          <div class="sp-muted small">Membership: <strong>${u.membership_tier}</strong>${u.has_accessibility_permit ? ' · <span class="badge text-bg-info">Accessibility permit</span>' : ""}
          · Waiting-list priority: <strong>${E.userPriority(u.user_id)}</strong></div></div>
        <a href="#/book" class="btn btn-teal"><i class="bi bi-plus-lg"></i> New booking</a></div>
      ${offers.map((o) => `<div class="alert alert-info d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div><i class="bi bi-bell-fill"></i> <strong>A slot is available for you!</strong> Your waiting-list request at <strong>${esc(o.location_name)}</strong>
          (${fmt(o.start_time, "short")}) has been matched. Pay within ${countdown(o.offer_expires_at)} to keep it.</div>
        <a class="btn btn-primary btn-sm" href="#/pay/${o.offered_reservation_id}">Pay &amp; confirm</a></div>`).join("")}
      <div class="row g-3 mb-4">${stat("calendar-event", "", active.length, "Active bookings")}${stat("check2-circle", "blue", mine.filter((r) => r.status === "COMPLETED").length, "Completed")}
        ${stat("hourglass-split", "amber", waiting.length, "Waiting-list requests")}${stat("currency-rupee", "blue", inr(spent), "Total spent")}</div>
      <div class="row g-4">
        <div class="col-lg-8"><div class="sp-card p-0 h-100">
          <div class="d-flex justify-content-between align-items-center p-3 border-bottom"><h2 class="h6 fw-bold mb-0">Upcoming &amp; active reservations</h2><a href="#/my-bookings" class="small">View all</a></div>
          ${active.length ? `<div class="list-group list-group-flush">${active.map((r) => `
            <a href="#/reservation/${r.reservation_id}" class="list-group-item list-group-item-action d-flex gap-3 align-items-center py-3">
              ${slotIcon(r.slot_type)}<div class="flex-grow-1"><div class="fw-semibold">${esc(r.location_name)} · Slot ${r.slot_code}</div>
              <div class="small sp-muted">${fmt(r.start_time, "full")} → ${fmt(r.end_time, "time")} · ${r.registration_no}</div>
              ${r.status === "HELD" ? `<div class="small text-warning-emphasis">Pay within ${countdown(r.hold_expires_at, false)} or the hold is released</div>` : ""}</div>
              <div class="text-end">${badge(r.status)}<div class="small fw-semibold mt-1">${inr(r.total_amount)}</div></div></a>`).join("")}</div>`
            : empty("calendar-x", "No upcoming bookings", "Find a slot to get started.", '<a href="#/book" class="btn btn-sm btn-primary mt-3">Find a slot</a>')}
        </div></div>
        <div class="col-lg-4">
          <div class="sp-card p-3 mb-4"><div class="d-flex justify-content-between mb-2"><h2 class="h6 fw-bold mb-0">My vehicles</h2><a href="#/vehicles" class="small">Manage</a></div>
            ${myVehicles().map((v) => `<div class="d-flex justify-content-between border-bottom py-2 small"><span><strong>${v.registration_no}</strong> · ${esc(v.model_name)}</span>
              ${v.is_ev ? `<span class="badge text-bg-info">${v.connector_type.replace("_", " ")}</span>` : ""}</div>`).join("") || '<div class="small sp-muted">No vehicles yet.</div>'}</div>
          <div class="sp-card p-3"><div class="d-flex justify-content-between mb-2"><h2 class="h6 fw-bold mb-0">Waiting list</h2><a href="#/waiting-list" class="small">Open</a></div>
            ${waiting.map((w) => `<div class="border-bottom py-2 small"><div class="fw-semibold">${esc(w.location_name)} · ${w.slot_type}${w.charger_type ? " " + w.charger_type : ""}</div>
              <div class="sp-muted">${fmt(w.start_time, "short")} · position <strong>#${w.queue_position}</strong></div></div>`).join("") || '<div class="small sp-muted">You are not waiting for any slot.</div>'}</div>
        </div>
      </div></div>` };
  }, "user");

  // ======================================================== LOCATIONS
  route(/^\/locations$/, (m, params) => {
    const cities = [...new Set(DB.locations.map((l) => l.city))].sort();
    const rows = DB.locations.filter((l) => l.is_active && (!params.city || l.city === params.city)).map((l) => {
      const slots = DB.slots.filter((s) => s.location_id === l.location_id && s.is_active);
      const ch = slots.map((s) => E.chargerOfSlot(s.slot_id)).filter(Boolean);
      return { ...l, total: slots.length, ev: slots.filter((s) => s.slot_type === "EV").length,
               free: slots.filter((s) => s.occupancy_status === "FREE").length,
               ac: ch.filter((c) => c.status === "OPERATIONAL" && c.charger_type === "AC").length,
               dc: ch.filter((c) => c.status === "OPERATIONAL" && c.charger_type === "DC").length,
               faulty: ch.filter((c) => c.status === "FAULTY").length };
    });
    return { title: "Locations", html: `<div class="container py-3">
      <div class="d-flex flex-wrap justify-content-between align-items-end gap-3 mb-4">
        <div><h1 class="h3 fw-bold mb-0">Parking locations</h1>
          <div class="sp-muted">“Free now” is the live physical status. Use <em>Check availability</em> to see bookable slots for your time.</div></div>
        <select class="form-select w-auto" id="city-filter"><option value="">All cities</option>${cities.map((c) => opt(c, c, params.city)).join("")}</select>
      </div>
      <div class="row g-4">${rows.map((l) => `<div class="col-md-6 col-lg-4"><div class="sp-card sp-card-hover h-100 d-flex flex-column">
        <div class="p-4 flex-grow-1">
          <div class="d-flex justify-content-between align-items-start mb-2"><h2 class="h5 fw-bold mb-0">${esc(l.name)}</h2><span class="badge text-bg-light border">${l.city}</span></div>
          <div class="small sp-muted mb-3"><i class="bi bi-geo-alt"></i> ${esc(l.address)}, ${l.pincode}</div>
          <div class="row text-center g-2 mb-3">
            <div class="col-4"><div class="fw-bold fs-5">${l.total}</div><div class="small sp-muted">Slots</div></div>
            <div class="col-4"><div class="fw-bold fs-5 text-success">${l.free}</div><div class="small sp-muted">Free now</div></div>
            <div class="col-4"><div class="fw-bold fs-5 text-info">${l.ev}</div><div class="small sp-muted">EV slots</div></div></div>
          <div class="d-flex flex-wrap gap-1">${l.ac ? `<span class="badge rounded-pill text-bg-info">${l.ac} AC working</span>` : ""}
            ${l.dc ? `<span class="badge rounded-pill text-bg-danger">${l.dc} DC fast working</span>` : ""}
            ${l.faulty ? `<span class="badge rounded-pill text-bg-warning"><i class="bi bi-exclamation-triangle"></i> ${l.faulty} faulty</span>` : ""}</div>
        </div>
        <div class="p-3 border-top d-flex gap-2"><a href="#/book?location_id=${l.location_id}" class="btn btn-primary btn-sm flex-grow-1">Check availability</a>
          ${l.ev ? `<a href="#/book?location_id=${l.location_id}&slot_type=EV" class="btn btn-outline-primary btn-sm"><i class="bi bi-ev-station"></i> EV</a>` : ""}</div>
      </div></div>`).join("")}</div></div>`,
    after() { document.getElementById("city-filter").onchange = (e) => go("#/locations" + (e.target.value ? "?city=" + encodeURIComponent(e.target.value) : "")); } };
  });

  // ======================================================== FIND & BOOK
  route(/^\/book$/, (m, params) => {
    const vehicles = myVehicles();
    const [ds, de] = defaultWindow();
    const p = { location_id: "", slot_type: "", charger_type: "", vehicle_id: vehicles[0]?.vehicle_id || "", start: toInput(ds), end: toInput(de), ...params };
    return { title: "Find & Book", html: `<div class="container py-3">
      <h1 class="h3 fw-bold mb-1">Find an available slot</h1>
      <p class="sp-muted">Only slots that are free for the <strong>whole</strong> period, fit your vehicle and (for EV slots) have a working, compatible charger are shown.</p>
      ${vehicles.length ? "" : '<div class="alert alert-warning">You need to <a href="#/vehicles">add a vehicle</a> before booking.</div>'}
      <form id="search-form" class="sp-card p-3 p-md-4 mb-4" novalidate><div class="row g-3">
        <div class="col-md-6 col-lg-3"><label class="form-label" for="s-vehicle">Vehicle</label>
          <select class="form-select" id="s-vehicle" name="vehicle_id" required>${vehicles.map((v) => opt(v.vehicle_id, `${v.registration_no} · ${v.model_name}${v.is_ev ? " ⚡" : ""}`, p.vehicle_id)).join("")}</select></div>
        <div class="col-md-6 col-lg-3"><label class="form-label" for="s-loc">Location</label>
          <select class="form-select" id="s-loc" name="location_id"><option value="">All locations</option>${DB.locations.filter((l) => l.is_active).map((l) => opt(l.location_id, `${l.name} (${l.city})`, p.location_id)).join("")}</select></div>
        <div class="col-6 col-lg-3"><label class="form-label" for="s-type">Slot type</label>
          <select class="form-select" id="s-type" name="slot_type">${opt("", "Any", p.slot_type)}${opt("REGULAR", "Regular parking", p.slot_type)}${opt("EV", "EV charging", p.slot_type)}</select></div>
        <div class="col-6 col-lg-3"><label class="form-label" for="s-ch">Charger</label>
          <select class="form-select" id="s-ch" name="charger_type">${opt("", "Any", p.charger_type)}${opt("AC", "AC (slow)", p.charger_type)}${opt("DC", "DC fast", p.charger_type)}</select></div>
        <div class="col-md-5"><label class="form-label" for="s-start">From</label><input type="datetime-local" class="form-control" id="s-start" name="start" value="${p.start}" step="900" required></div>
        <div class="col-md-5"><label class="form-label" for="s-end">Until</label><input type="datetime-local" class="form-control" id="s-end" name="end" value="${p.end}" step="900" required></div>
        <div class="col-md-2 d-flex align-items-end"><button class="btn btn-primary w-100" ${vehicles.length ? "" : "disabled"}><i class="bi bi-search"></i> Search</button></div>
      </div></form>
      <div id="results"></div>
    </div>
    <div class="modal fade" id="bookModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered"><div class="modal-content">
      <div class="modal-header"><h5 class="modal-title fw-bold">Confirm reservation</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body" id="book-summary"></div>
      <div class="modal-footer"><button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Back</button>
        <button type="button" class="btn btn-teal" id="book-confirm"><i class="bi bi-lock"></i> Reserve now</button></div>
    </div></div></div>`,
    after() {
      const out = document.getElementById("results");
      const modal = new bootstrap.Modal(document.getElementById("bookModal"));
      let q = null, chosen = null;
      document.getElementById("s-ch").onchange = (e) => { if (e.target.value) document.getElementById("s-type").value = "EV"; };
      function search(d) {
        q = { ...d, startD: parseLocal(d.start), endD: parseLocal(d.end) };
        let rows;
        try {
          rows = E.searchSlots({ start: q.startD, end: q.endD, locationId: d.location_id || null, slotType: d.slot_type || null,
                                 chargerType: d.charger_type || null, vehicleId: d.vehicle_id });
        } catch (err) { out.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`; return; }
        if (!rows.length) {
          const canWait = d.location_id && d.slot_type;
          out.innerHTML = `<div class="sp-card p-5 text-center"><i class="bi bi-emoji-frown display-5 sp-muted"></i>
            <h3 class="h5 fw-bold mt-2">No compatible slot is free for this time</h3>
            ${canWait ? `<p class="sp-muted">Join the priority waiting list — you'll get a 10-minute offer when a matching slot frees up.</p>
              <button class="btn btn-primary" id="join-wait"><i class="bi bi-hourglass-split"></i> Join waiting list</button>`
              : '<p class="sp-muted">To join the waiting list, pick a specific <strong>location</strong> and <strong>slot type</strong> and search again.</p>'}</div>`;
          const jw = document.getElementById("join-wait");
          if (jw) jw.onclick = () => act(() => E.joinWaitingList(A.state.userId, d.vehicle_id, d.location_id, d.slot_type, d.charger_type || null, q.startD, q.endD),
                                         (id) => `Added to the waiting list (entry #${id}).`, "#/waiting-list");
          return;
        }
        out.innerHTML = `<div class="d-flex justify-content-between mb-2"><h2 class="h6 fw-bold mb-0">${rows.length} slot${rows.length === 1 ? "" : "s"} available</h2>
          <span class="small sp-muted">Prices include peak-hour pricing</span></div><div class="row g-3">${rows.map((s, i) => `
          <div class="col-md-6 col-xl-4 sp-fade-in"><div class="sp-card sp-card-hover p-3 h-100 d-flex flex-column">
            <div class="d-flex gap-3 align-items-center mb-2">${slotIcon(s.slot_type)}
              <div class="flex-grow-1"><div class="fw-bold">${esc(s.location_name)} · ${s.slot_code}</div>
                <div class="small sp-muted">${s.city} · Floor ${s.floor_level} · ${s.size_class} size</div></div>
              <span class="badge text-bg-${s.occupancy_status === "FREE" ? "success" : "secondary"}" title="Physical status right now">${s.occupancy_status === "FREE" ? "Free now" : "Occupied now"}</span></div>
            ${s.charger_type ? `<div class="mb-2">${chargerLabel(s.charger_type, s.power_kw, s.connector_type)}</div>` : ""}
            <div class="small sp-muted mb-3">Parking ${inr(s.est_parking_fee)}${s.charger_type ? ` + charging ${inr(s.est_charging_fee)}` : ""}</div>
            <div class="mt-auto d-flex justify-content-between align-items-center"><span class="sp-price">${inr(s.est_total)}</span>
              <button class="btn btn-teal btn-sm" data-idx="${i}"><i class="bi bi-lock"></i> Reserve</button></div>
          </div></div>`).join("")}</div>`;
        out.querySelectorAll("[data-idx]").forEach((b) => b.onclick = () => {
          chosen = rows[b.dataset.idx];
          const v = E.vehicle(q.vehicle_id);
          document.getElementById("book-summary").innerHTML = `<dl class="row mb-0">
            <dt class="col-4">Location</dt><dd class="col-8">${esc(chosen.location_name)}, ${chosen.city}</dd>
            <dt class="col-4">Slot</dt><dd class="col-8">${chosen.slot_code} (${chosen.slot_type}${chosen.charger_type ? `, ${chosen.charger_type} ${chosen.power_kw} kW` : ""})</dd>
            <dt class="col-4">Vehicle</dt><dd class="col-8">${v.registration_no} · ${esc(v.model_name)}</dd>
            <dt class="col-4">From</dt><dd class="col-8">${fmt(q.startD, "full")}</dd><dt class="col-4">Until</dt><dd class="col-8">${fmt(q.endD, "full")}</dd>
            <dt class="col-4">Estimated</dt><dd class="col-8 sp-price">${inr(chosen.est_total)}</dd></dl>
            <div class="alert alert-light border small mt-3 mb-0"><i class="bi bi-info-circle"></i> The slot is <strong>held for 10 minutes</strong> while you pay.</div>`;
          modal.show();
        });
      }
      document.getElementById("book-confirm").onclick = () => {
        try {
          const id = E.createReservation(A.state.userId, q.vehicle_id, chosen.slot_id, q.startD, q.endD);
          modal.hide();
          flash(`Slot held! Reservation #${id}. Complete payment within 10 minutes to confirm.`);
          go("#/reservation/" + id);
        } catch (err) {
          modal.hide();
          A.toast(err.code === "SLOT_UNAVAILABLE" ? "Slot Unavailable — it was booked meanwhile. Showing fresh results." : err.message, "danger");
          search(q);
        }
      };
      onSubmit("#search-form", search);
      if (vehicles.length) search(A.formData(document.getElementById("search-form")));
    } };
  }, "user");

  // ======================================================== RESERVATION DETAIL
  function getRes(id) {
    const r = E.reservation(id);
    if (!r || (r.user_id !== A.state.userId && !isAdmin())) throw new E.DemoError("RESERVATION_NOT_FOUND", "Reservation not found");
    return details(r);
  }
  route(/^\/reservation\/(\d+)$/, (m) => {
    const r = getRes(m[1]);
    const bill = E.finalBill(r.reservation_id);
    const pays = DB.payments.filter((p) => p.reservation_id === r.reservation_id);
    const flow = ["HELD", "CONFIRMED", "CHECKED_IN", "COMPLETED"];
    const pos = flow.indexOf(r.status);
    const admin = isAdmin();
    const line = (label, value, cls = "") => `<div class="d-flex justify-content-between small mb-1 ${cls}"><span>${label}</span><span>${value}</span></div>`;
    return { title: `Reservation #${r.reservation_id}`, html: `<div class="container py-3">
      <a href="${admin ? "#/admin/reservations" : "#/my-bookings"}" class="small"><i class="bi bi-arrow-left"></i> Back</a>
      <h1 class="h3 fw-bold mb-3">Reservation #${r.reservation_id} ${badge(r.status)}
        ${r.source === "WAITLIST" ? '<span class="badge text-bg-light border fs-6 align-middle"><i class="bi bi-hourglass-split"></i> from waiting list</span>' : ""}</h1>
      ${r.status === "HELD" ? `<div class="alert alert-warning d-flex flex-wrap justify-content-between align-items-center gap-2"><div><i class="bi bi-clock"></i>
          This slot is <strong>held</strong> for you. Pay within ${countdown(r.hold_expires_at)} or it will be released.</div>
          <a href="#/pay/${r.reservation_id}" class="btn btn-primary btn-sm"><i class="bi bi-credit-card"></i> Pay ${inr(r.parking_fee + r.charging_fee)}</a></div>`
        : r.status === "CONFIRMED" ? '<div class="alert alert-success"><i class="bi bi-check-circle"></i> <strong>Booking confirmed.</strong> Check in from 15 minutes before the start time.</div>'
        : r.cancel_reason && ["CANCELLED", "EXPIRED", "NO_SHOW"].includes(r.status) ? `<div class="alert alert-secondary">${esc(r.cancel_reason)}</div>` : ""}
      <div class="row g-4">
        <div class="col-lg-8">
          <div class="sp-card p-4 mb-4">
            ${pos >= 0 ? `<div class="sp-steps mb-4">${[["Held", "lock"], ["Confirmed", "credit-card"], ["Checked in", "box-arrow-in-right"], ["Completed", "flag"]]
              .map(([t, i], k) => `<div class="sp-step ${k < pos || r.status === "COMPLETED" ? "done" : k === pos ? "current" : ""}"><div class="dot"><i class="bi bi-${i}"></i></div><span>${t}</span></div>`).join("")}</div>` : ""}
            <div class="d-flex gap-3 align-items-center mb-3">${slotIcon(r.slot_type)}<div>
              <div class="h5 fw-bold mb-0">${esc(r.location_name)} · Slot ${r.slot_code}</div>
              <div class="sp-muted small">${r.city} · Floor ${r.floor_level} ${chargerLabel(r.charger_type, r.power_kw, r.connector_type)}</div></div></div>
            <div class="row g-3 small">
              <div class="col-sm-6"><div class="sp-muted">From</div><div class="fw-semibold">${fmt(r.start_time, "full")}</div></div>
              <div class="col-sm-6"><div class="sp-muted">Until</div><div class="fw-semibold">${fmt(r.end_time, "full")}</div></div>
              <div class="col-sm-6"><div class="sp-muted">Vehicle</div><div class="fw-semibold">${r.registration_no} · ${esc(r.model_name)}</div></div>
              <div class="col-sm-6"><div class="sp-muted">Booked by</div><div class="fw-semibold">${esc(r.full_name)}</div></div>
              ${r.check_in_time ? `<div class="col-sm-6"><div class="sp-muted">Checked in</div><div class="fw-semibold">${fmt(r.check_in_time)}</div></div>` : ""}
              ${r.check_out_time ? `<div class="col-sm-6"><div class="sp-muted">Checked out</div><div class="fw-semibold">${fmt(r.check_out_time)}</div></div>` : ""}
            </div>
          </div>
          <div class="sp-card p-0"><div class="p-3 border-bottom fw-bold">Payments</div><div class="table-responsive"><table class="table mb-0">
            <thead><tr><th>Txn</th><th>Type</th><th>Method</th><th>Amount</th><th>Status</th><th>When</th></tr></thead><tbody>
            ${pays.map((p) => `<tr><td class="small"><code>${p.transaction_ref}</code></td><td>${p.payment_type}</td><td>${p.method}</td><td>${inr(p.amount)}</td><td>${badge(p.status)}</td><td class="small">${fmt(p.paid_at)}</td></tr>`).join("")
              || '<tr><td colspan="6" class="text-center sp-muted py-3">No payments yet.</td></tr>'}
          </tbody></table></div></div>
        </div>
        <div class="col-lg-4">
          <div class="sp-card p-4 mb-4"><h2 class="h6 fw-bold mb-3">Bill</h2>
            ${line("Parking", inr(bill.parking_fee))}${line("EV charging", inr(bill.charging_fee))}
            ${line(`Overstay fine${bill.overstay_minutes ? ` (${bill.overstay_minutes} min late)` : ""}`, inr(bill.overstay_fine), bill.overstay_fine > 0 ? "text-danger fw-semibold" : "")}
            <hr><div class="d-flex justify-content-between fw-bold"><span>Total</span><span>${inr(bill.total_amount)}</span></div>
            ${line("Paid", inr(bill.amount_paid), "sp-muted")}${bill.amount_refunded > 0 ? line("Refunded", inr(bill.amount_refunded), "text-success") : ""}
            ${bill.balance_due > 0 && r.status !== "HELD" ? `<div class="d-flex justify-content-between fw-bold text-danger mt-1"><span>Balance due</span><span>${inr(bill.balance_due)}</span></div>` : ""}
          </div>
          <div class="sp-card p-4"><h2 class="h6 fw-bold mb-3">Actions</h2><div class="d-grid gap-2">
            ${r.status === "HELD" || (r.status === "COMPLETED" && bill.balance_due > 0) ? `<a href="#/pay/${r.reservation_id}" class="btn btn-primary"><i class="bi bi-credit-card"></i> ${r.status === "HELD" ? "Pay &amp; confirm" : "Pay balance"}</a>` : ""}
            ${r.status === "CONFIRMED" ? '<button class="btn btn-teal" id="btn-checkin"><i class="bi bi-box-arrow-in-right"></i> Check in</button>' : ""}
            ${r.status === "CHECKED_IN" ? `<form id="checkout-form">${admin ? `<label class="form-label small" for="checkout_time">Simulate check-out time (admin)</label>
                <input type="datetime-local" class="form-control form-control-sm mb-2" id="checkout_time" name="checkout_time" value="${toInput(r.end_time)}">` : ""}
                <button class="btn btn-teal w-100"><i class="bi bi-box-arrow-right"></i> Check out</button></form>` : ""}
            ${["HELD", "CONFIRMED"].includes(r.status) && (r.start_time > new Date() || admin) ? `<form id="cancel-form" data-confirm="Cancel this reservation? Any payment will be refunded in full.">
                <button class="btn btn-outline-danger w-100"><i class="bi bi-x-circle"></i> Cancel reservation</button></form>` : ""}
            ${["COMPLETED", "CANCELLED", "EXPIRED", "NO_SHOW"].includes(r.status) ? `<a href="#/book?location_id=${r.location_id}" class="btn btn-outline-primary">Book again</a>` : ""}
          </div><div class="small sp-muted mt-3">Overstay rule: 15 minutes grace after your end time; after that every started hour costs 2× the parking rate.</div></div>
        </div>
      </div></div>`,
    after() {
      const uid = A.state.userId, id = r.reservation_id;
      const ci = document.getElementById("btn-checkin");
      if (ci) ci.onclick = () => act(() => E.checkIn(id, uid, admin), (t) => `Checked in at ${fmt(t, "time")}. The slot is now marked OCCUPIED (trigger B).`);
      onSubmit("#checkout-form", (d) => act(() => E.checkOut(id, uid, admin, admin && d.checkout_time ? parseLocal(d.checkout_time) : null), (b) =>
        `Checked out. Total ${inr(b.total_amount)}.` + (b.overstay_fine > 0 ? ` Overstay of ${b.overstay_minutes} min → fine ${inr(b.overstay_fine)} (trigger A). Balance due ${inr(b.balance_due)}.` : "")));
      onSubmit("#cancel-form", () => act(() => E.cancelReservation(id, uid, admin, admin ? "Cancelled by admin" : "Cancelled by user"),
        (refund) => refund ? `Reservation cancelled. Refund: ${inr(refund)}` : "Reservation cancelled."));
    } };
  }, "user");

  // ======================================================== PAYMENT
  route(/^\/pay\/(\d+)$/, (m) => {
    const r = getRes(m[1]);
    const bill = E.finalBill(r.reservation_id);
    let amount;
    if (r.status === "HELD") amount = r.parking_fee + r.charging_fee;
    else if (r.status === "COMPLETED" && bill.balance_due > 0) amount = bill.balance_due;
    else { flash("Nothing to pay for this reservation.", "info"); setTimeout(() => go("#/reservation/" + r.reservation_id)); return { html: "" }; }
    return { title: "Payment", html: `<div class="container py-3"><div class="row justify-content-center"><div class="col-lg-6"><div class="sp-card p-4 p-md-5 sp-fade-in">
      <div class="d-flex justify-content-between align-items-start mb-3"><div><div class="small text-uppercase sp-muted">SmartPark Pay · simulated gateway</div>
        <h1 class="h4 fw-bold mb-0">${r.status === "HELD" ? "Confirm your booking" : "Pay outstanding balance"}</h1></div><span class="badge text-bg-warning">TEST MODE</span></div>
      <div class="bg-light rounded-3 p-3 mb-4 small">
        <div class="d-flex justify-content-between"><span>Reservation</span><strong>#${r.reservation_id}</strong></div>
        <div class="d-flex justify-content-between"><span>Slot</span><strong>${esc(r.location_name)} · ${r.slot_code}</strong></div>
        <div class="d-flex justify-content-between"><span>Time</span><strong>${fmt(r.start_time, "short")} – ${fmt(r.end_time, "time")}</strong></div>
        ${r.status === "HELD" ? `<div class="d-flex justify-content-between"><span>Hold expires in</span><strong class="text-danger">${countdown(r.hold_expires_at)}</strong></div>` : ""}
        <hr class="my-2"><div class="d-flex justify-content-between fs-5"><span>Amount</span><strong>${inr(amount)}</strong></div>
        <div class="sp-muted">Amount is calculated by the system — it cannot be changed from the browser form.</div></div>
      <form id="pay-form" novalidate>
        <div class="row g-2 mb-3">${[["UPI", "phone"], ["CARD", "credit-card"], ["NETBANKING", "bank"], ["WALLET", "wallet2"]].map(([mth, i], k) => `<div class="col-6">
          <input type="radio" class="btn-check" name="method" id="m-${mth}" value="${mth}" ${k === 0 ? "checked" : ""}>
          <label class="btn btn-outline-primary w-100 py-3" for="m-${mth}"><i class="bi bi-${i} d-block fs-4"></i>${mth[0] + mth.slice(1).toLowerCase()}</label></div>`).join("")}</div>
        <div class="form-check mb-4"><input class="form-check-input" type="checkbox" id="simulate_failure" name="simulate_failure">
          <label class="form-check-label small" for="simulate_failure">Simulate a failed payment</label></div>
        <button class="btn btn-teal w-100 py-2"><i class="bi bi-shield-lock"></i> Pay ${inr(amount)}</button>
        <a href="#/reservation/${r.reservation_id}" class="btn btn-link w-100 mt-1">Back to reservation</a>
      </form></div></div></div></div>`,
    after() {
      onSubmit("#pay-form", (d) => {
        const failSim = !!d.simulate_failure;
        act(() => E.makePayment(r.reservation_id, A.state.userId, d.method, isAdmin(), failSim), null, () => {
          if (failSim) { flash("Payment FAILED (simulated). Your hold is still active — you can try again.", "warning"); A.render(); }
          else { flash(r.status === "HELD" ? "Payment successful! Your reservation is confirmed." : "Payment successful! Your balance is cleared."); go("#/reservation/" + r.reservation_id); }
        });
      });
    } };
  }, "user");

  // ======================================================== MY BOOKINGS / PAYMENTS
  route(/^\/my-bookings$/, () => {
    const rows = DB.reservations.filter((r) => r.user_id === A.state.userId).map(details).sort((a, b) => b.start_time - a.start_time);
    const active = rows.filter((r) => E.ACTIVE.includes(r.status)).sort((a, b) => a.start_time - b.start_time);
    const history = rows.filter((r) => !E.ACTIVE.includes(r.status));
    const table = (list) => list.length ? `<div class="table-responsive"><table class="table table-hover mb-0">
      <thead><tr><th>#</th><th>Slot</th><th>When</th><th>Vehicle</th><th>Status</th><th class="text-end">Total</th><th></th></tr></thead><tbody>
      ${list.map((r) => `<tr><td class="sp-muted">${r.reservation_id}</td>
        <td><div class="d-flex gap-2 align-items-center">${slotIcon(r.slot_type)}<div><div class="fw-semibold">${esc(r.location_name)}</div>
          <div class="small sp-muted">Slot ${r.slot_code}${r.charger_type ? ` · ${r.charger_type} ${r.power_kw} kW` : ""}</div></div></div></td>
        <td class="small">${fmt(r.start_time, "day")}<br>${fmt(r.start_time, "time")} – ${fmt(r.end_time, "time")}</td><td class="small">${r.registration_no}</td>
        <td>${badge(r.status)}${r.overstay_fine > 0 ? `<div class="small text-danger">fine ${inr(r.overstay_fine)}</div>` : ""}</td>
        <td class="text-end fw-semibold">${inr(r.total_amount)}</td><td class="text-end"><a class="btn btn-sm btn-outline-primary" href="#/reservation/${r.reservation_id}">Open</a></td></tr>`).join("")}
      </tbody></table></div>` : empty("calendar-x", "Nothing here yet", "Your reservations will appear here.");
    return { title: "My Bookings", html: `<div class="container py-3">
      <div class="d-flex justify-content-between align-items-center mb-3"><h1 class="h3 fw-bold mb-0">My bookings</h1><a href="#/book" class="btn btn-teal"><i class="bi bi-plus-lg"></i> New booking</a></div>
      <ul class="nav nav-pills mb-3"><li class="nav-item"><button class="nav-link active" data-bs-toggle="pill" data-bs-target="#tab-a">Upcoming &amp; active <span class="badge text-bg-light">${active.length}</span></button></li>
        <li class="nav-item"><button class="nav-link" data-bs-toggle="pill" data-bs-target="#tab-h">History <span class="badge text-bg-light">${history.length}</span></button></li></ul>
      <div class="tab-content"><div class="tab-pane fade show active" id="tab-a"><div class="sp-card p-0">${table(active)}</div></div>
        <div class="tab-pane fade" id="tab-h"><div class="sp-card p-0">${table(history)}</div></div></div></div>` };
  }, "user");

  route(/^\/payments$/, () => {
    const mineIds = new Set(DB.reservations.filter((r) => r.user_id === A.state.userId).map((r) => r.reservation_id));
    const rows = DB.payments.filter((p) => mineIds.has(p.reservation_id)).sort((a, b) => b.paid_at - a.paid_at);
    return { title: "My Payments", html: `<div class="container py-3"><h1 class="h3 fw-bold mb-3">My payments</h1><div class="sp-card p-0">
      ${rows.length ? `<div class="table-responsive"><table class="table table-hover mb-0"><thead><tr><th>Transaction</th><th>Reservation</th><th>Type</th><th>Method</th><th>Status</th><th>Date</th><th class="text-end">Amount</th></tr></thead><tbody>
      ${rows.map((p) => { const d = details(E.reservation(p.reservation_id)); return `<tr><td><code class="small">${p.transaction_ref}</code></td>
        <td><a href="#/reservation/${p.reservation_id}">#${p.reservation_id}</a><div class="small sp-muted">${esc(d.location_name)} · ${d.slot_code}</div></td>
        <td>${p.payment_type}</td><td>${p.method}</td><td>${badge(p.status)}</td><td class="small">${fmt(p.paid_at)}</td><td class="text-end fw-semibold">${inr(p.amount)}</td></tr>`; }).join("")}
      </tbody></table></div>` : empty("receipt", "No payments yet", "Payments for your bookings will appear here.")}</div></div>` };
  }, "user");

  // ======================================================== WAITING LIST
  route(/^\/waiting-list$/, (m, params) => {
    const entries = E.waitingQueue().filter((w) => w.user_id === A.state.userId).sort((a, b) => b.requested_at - a.requested_at);
    const vehicles = myVehicles();
    const [ds, de] = defaultWindow();
    return { title: "Waiting List", html: `<div class="container py-3">
      <h1 class="h3 fw-bold mb-1">Priority waiting list</h1>
      <p class="sp-muted">Order: <strong>priority</strong> (higher first) → <strong>request time</strong> (earlier first) → entry number. When a matching slot frees up you get a
        <strong>temporary offer</strong> — pay within 10 minutes to confirm, otherwise it passes to the next person.</p>
      <div class="row g-4">
        <div class="col-lg-8"><div class="sp-card p-0"><div class="p-3 border-bottom fw-bold">My requests</div>
          ${entries.length ? `<div class="table-responsive"><table class="table mb-0"><thead><tr><th>#</th><th>Where</th><th>When</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>
          ${entries.map((e) => `<tr><td class="sp-muted">${e.entry_id}</td>
            <td><div class="fw-semibold">${esc(e.location_name)}</div><div class="small sp-muted">${e.slot_type}${e.charger_type ? " · " + e.charger_type : ""} · ${e.registration_no}</div></td>
            <td class="small">${fmt(e.start_time, "short")} – ${fmt(e.end_time, "time")}</td>
            <td><span class="badge text-bg-light border">${e.priority} · ${e.priority_label}</span></td>
            <td>${badge(e.status)}${e.status === "WAITING" ? `<div class="small">Position <strong>#${e.queue_position}</strong></div>` : ""}
              ${e.status === "OFFERED" ? `<div class="small">expires in ${countdown(e.offer_expires_at)}</div>` : ""}</td>
            <td class="text-end text-nowrap">${e.status === "OFFERED" ? `<a class="btn btn-sm btn-primary" href="#/pay/${e.offered_reservation_id}">Pay &amp; confirm</a>` : ""}
              ${e.status === "ACCEPTED" ? `<a class="btn btn-sm btn-outline-primary" href="#/reservation/${e.offered_reservation_id}">View booking</a>` : ""}
              ${["WAITING", "OFFERED"].includes(e.status) ? `<button class="btn btn-sm btn-outline-danger" data-leave="${e.entry_id}" data-status="${e.status}">${e.status === "OFFERED" ? "Decline" : "Leave"}</button>` : ""}</td></tr>`).join("")}
          </tbody></table></div>` : empty("hourglass", "You are not on any waiting list", "Use the form to join one when a location is full.")}
        </div></div>
        <div class="col-lg-4"><form id="wait-form" class="sp-card p-4" novalidate><h2 class="h6 fw-bold mb-3">Join a waiting list</h2>
          <div class="mb-2"><label class="form-label small" for="w-v">Vehicle</label><select class="form-select" id="w-v" name="vehicle_id" required>
            ${vehicles.map((v) => opt(v.vehicle_id, v.registration_no + (v.is_ev ? " ⚡" : ""), params.vehicle_id)).join("")}</select></div>
          <div class="mb-2"><label class="form-label small" for="w-l">Location</label><select class="form-select" id="w-l" name="location_id" required>
            ${DB.locations.filter((l) => l.is_active).map((l) => opt(l.location_id, l.name, params.location_id)).join("")}</select></div>
          <div class="row g-2 mb-2"><div class="col-6"><label class="form-label small" for="w-t">Slot type</label><select class="form-select" id="w-t" name="slot_type">
              ${opt("REGULAR", "Regular", params.slot_type)}${opt("EV", "EV", params.slot_type)}</select></div>
            <div class="col-6"><label class="form-label small" for="w-c">Charger</label><select class="form-select" id="w-c" name="charger_type">
              ${opt("", "Any", params.charger_type)}${opt("AC", "AC", params.charger_type)}${opt("DC", "DC fast", params.charger_type)}</select></div></div>
          <div class="mb-2"><label class="form-label small" for="w-s">From</label><input type="datetime-local" class="form-control" id="w-s" name="start" value="${params.start || toInput(ds)}" step="900" required></div>
          <div class="mb-3"><label class="form-label small" for="w-e">Until</label><input type="datetime-local" class="form-control" id="w-e" name="end" value="${params.end || toInput(de)}" step="900" required></div>
          <button class="btn btn-primary w-100" ${vehicles.length ? "" : "disabled"}>Join waiting list</button>
          <div class="small sp-muted mt-2">You can only join when nothing compatible is free. Tip: Chennai Central · EV · DC · tomorrow 18:00–20:00 is full.</div>
        </form></div>
      </div></div>`,
    after() {
      onSubmit("#wait-form", (d) => act(() => E.joinWaitingList(A.state.userId, d.vehicle_id, d.location_id, d.slot_type, d.charger_type || null,
                                                                 parseLocal(d.start), parseLocal(d.end)),
                                        (id) => `You joined the waiting list (entry #${id}).`));
      document.querySelectorAll("[data-leave]").forEach((b) => b.onclick = () => {
        if (!confirm(b.dataset.status === "OFFERED" ? "Decline this offer?" : "Leave the waiting list?")) return;
        act(() => E.leaveWaitingList(b.dataset.leave, A.state.userId, isAdmin()), "You left the waiting list.");
      });
    } };
  }, "user");

  // ======================================================== VEHICLES
  route(/^\/vehicles$/, () => {
    const vs = myVehicles();
    return { title: "My Vehicles", html: `<div class="container py-3"><h1 class="h3 fw-bold mb-3">My vehicles</h1><div class="row g-4">
      <div class="col-lg-7"><div class="sp-card p-0">${vs.length ? `<div class="table-responsive"><table class="table mb-0">
        <thead><tr><th>Registration</th><th>Model</th><th>Type</th><th>EV connector</th><th>Bookings</th><th></th></tr></thead><tbody>
        ${vs.map((v) => `<tr><td class="fw-semibold">${v.registration_no}</td><td>${esc(v.model_name)}</td><td>${v.vehicle_type}</td>
          <td>${v.is_ev ? `<span class="badge text-bg-info">${v.connector_type.replace("_", " ")}</span>` : '<span class="sp-muted">—</span>'}</td>
          <td>${DB.reservations.filter((r) => r.vehicle_id === v.vehicle_id).length}</td>
          <td class="text-end"><button class="btn btn-sm btn-outline-danger" data-del="${v.vehicle_id}"><i class="bi bi-trash"></i></button></td></tr>`).join("")}
        </tbody></table></div>` : empty("car-front", "No vehicles yet", "Add a vehicle to start booking.")}</div></div>
      <div class="col-lg-5"><form id="veh-form" class="sp-card p-4" novalidate><h2 class="h6 fw-bold mb-3">Add a vehicle</h2>${vehicleFields(true)}
        <button class="btn btn-primary w-100 mt-3">Add vehicle</button></form></div></div></div>`,
    after() {
      onSubmit("#veh-form", (d) => act(() => E.addVehicle(A.state.userId, d), "Vehicle added."));
      document.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => {
        if (confirm("Remove this vehicle?")) act(() => E.deleteVehicle(A.state.userId, b.dataset.del), "Vehicle removed.");
      });
    } };
  }, "user");
})();
