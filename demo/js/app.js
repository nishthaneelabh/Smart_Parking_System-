// Single-page app shell: hash router, navbar, flash messages, shared view helpers.
// Everything lives in memory — a page refresh re-runs the seed and logs you out.
(function () {
  const { esc, fmt } = window.SPU;
  const E = window.SPDB;

  const REPO_URL = "https://github.com/nishthaneelabh/Smart_Parking_System-";
  const state = { userId: null, flash: [] };
  const routes = [];

  // ------------------------------------------------------------ session
  const currentUser = () => (state.userId ? E.user(state.userId) : null);
  const isAdmin = () => currentUser()?.role === "ADMIN";

  // ------------------------------------------------------------ routing
  function route(pattern, view, access = "public") { routes.push({ pattern, view, access }); }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

  function flash(message, type = "success") { state.flash.push([type, message]); }

  // Run an action; show a green message on success, the database-style error otherwise.
  function act(fn, success, then) {
    try {
      const result = fn();
      if (success) flash(typeof success === "function" ? success(result) : success, "success");
      if (typeof then === "function") then(result); else go(then || location.hash);
    } catch (err) {
      if (!(err instanceof E.DemoError)) { console.error(err); flash("Unexpected error: " + err.message, "danger"); }
      else flash(err.message, "danger");
      render();
    }
  }

  function toast(message, type = "success") {
    const el = document.createElement("div");
    el.className = `toast align-items-center text-bg-${type} border-0`;
    el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
    document.getElementById("toast-area").appendChild(el);
    const t = new bootstrap.Toast(el, { delay: 5000 });
    t.show();
    el.addEventListener("hidden.bs.toast", () => el.remove());
  }

  // ------------------------------------------------------------ rendering
  function navbar() {
    const u = currentUser();
    const h = location.hash || "#/";
    const link = (href, icon, label) =>
      `<li class="nav-item"><a class="nav-link ${h.startsWith(href) && (href !== "#/" || h === "#/") ? "active" : ""}" href="${href}"><i class="bi bi-${icon}"></i> ${label}</a></li>`;
    return `<div class="container">
      <a class="navbar-brand d-flex align-items-center gap-2 fw-semibold" href="#/">
        <img src="logo.svg" alt="" width="30" height="30"> SmartPark <span class="text-teal">EV</span></a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navc" aria-label="Menu"><span class="navbar-toggler-icon"></span></button>
      <div class="collapse navbar-collapse" id="navc">
        <ul class="navbar-nav me-auto">
          ${link("#/locations", "geo-alt", "Locations")}
          ${u ? link("#/book", "search", "Find &amp; Book") + link("#/my-bookings", "calendar-check", "My Bookings") +
                link("#/waiting-list", "hourglass-split", "Waiting List") : ""}
          ${u && u.role === "ADMIN" ? link("#/admin", "speedometer2", "Admin") : ""}
        </ul>
        <ul class="navbar-nav">
          ${u ? `<li class="nav-item dropdown">
              <a class="nav-link dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown"><i class="bi bi-person-circle"></i> ${esc(u.full_name)}
                ${u.role === "ADMIN" ? '<span class="badge text-bg-warning ms-1">ADMIN</span>' : ""}</a>
              <ul class="dropdown-menu dropdown-menu-end">
                <li><a class="dropdown-item" href="#/dashboard"><i class="bi bi-grid"></i> Dashboard</a></li>
                <li><a class="dropdown-item" href="#/vehicles"><i class="bi bi-car-front"></i> My Vehicles</a></li>
                <li><a class="dropdown-item" href="#/payments"><i class="bi bi-receipt"></i> Payments</a></li>
                <li><hr class="dropdown-divider"></li>
                <li><button class="dropdown-item text-danger" id="logout-btn"><i class="bi bi-box-arrow-right"></i> Log out</button></li>
              </ul></li>`
            : `<li class="nav-item"><a class="nav-link" href="#/login">Log in</a></li>
               <li class="nav-item"><a class="btn btn-teal btn-sm ms-lg-2 mt-1" href="#/register">Sign up</a></li>`}
        </ul>
      </div></div>`;
  }

  function render() {
    const hash = location.hash || "#/";
    const [path, query] = hash.slice(1).split("?");
    const params = Object.fromEntries(new URLSearchParams(query || ""));
    let match = null, r = null;
    for (r of routes) { match = r.pattern.exec(path); if (match) break; }
    if (!match) { r = null; }

    if (r && r.access !== "public" && !currentUser()) {
      flash("Please log in to continue.", "warning");
      location.hash = "#/login?next=" + encodeURIComponent(hash);
      return;
    }
    let view;
    if (!r) view = errorView(404, "Page not found", "That page does not exist.");
    else if (r.access === "admin" && !isAdmin()) view = errorView(403, "Access denied", "This page is only for administrators.");
    else {
      try { view = r.view(match, params); }
      catch (err) { view = errorView(err.code === "RESERVATION_NOT_FOUND" ? 404 : 400, (err.code || "Error").replace(/_/g, " "), err.message); }
    }

    document.getElementById("nav").innerHTML = navbar();
    document.getElementById("flash-area").innerHTML = state.flash.map(([type, msg]) =>
      `<div class="alert alert-${type} alert-dismissible fade show sp-fade-in" role="alert">${esc(msg)}
       <button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>`).join("");
    state.flash = [];
    document.getElementById("app").innerHTML = view.html;
    document.title = `${view.title || "SmartPark EV"} · SmartPark EV Demo`;
    const logout = document.getElementById("logout-btn");
    if (logout) logout.onclick = () => { state.userId = null; flash("You have been logged out.", "info"); go("#/"); };
    if (view.after) view.after();
    tickCountdowns();
    window.scrollTo(0, 0);
  }

  function errorView(code, title, message) {
    return { title, html: `<div class="container py-5"><div class="sp-card p-5 text-center mx-auto" style="max-width:560px">
      <div class="display-4 fw-bold text-primary mb-2">${code}</div><h1 class="h4 fw-bold">${esc(title)}</h1>
      <p class="sp-muted">${esc(message)}</p><a href="#/" class="btn btn-primary">Go home</a></div></div>` };
  }

  // ------------------------------------------------------------ shared HTML helpers
  const COLORS = {
    HELD: "warning", CONFIRMED: "primary", CHECKED_IN: "info", COMPLETED: "success", CANCELLED: "secondary",
    EXPIRED: "dark", NO_SHOW: "danger", WAITING: "warning", OFFERED: "info", ACCEPTED: "success",
    OPERATIONAL: "success", FAULTY: "danger", FREE: "success", OCCUPIED: "danger", SUCCESS: "success",
    FAILED: "danger", REFUNDED: "secondary",
  };
  const badgeColor = (s) => COLORS[s] || "secondary";
  const badge = (s) => `<span class="badge sp-badge text-bg-${badgeColor(s)}">${esc(String(s).replace(/_/g, " "))}</span>`;
  const slotIcon = (type) => type === "EV"
    ? '<span class="sp-slot-icon sp-ev" title="EV charging slot"><i class="bi bi-ev-station"></i></span>'
    : '<span class="sp-slot-icon" title="Regular parking"><i class="bi bi-p-square"></i></span>';
  const chargerLabel = (type, kw, conn) => type
    ? `<span class="badge rounded-pill ${type === "DC" ? "text-bg-danger" : "text-bg-info"}">${type}${type === "DC" ? " Fast" : ""} · ${Number(kw)} kW</span>
       <span class="badge rounded-pill text-bg-light border">${esc(conn.replace("_", " "))}</span>` : "";
  const empty = (icon, title, text, extra = "") => `<div class="text-center text-muted py-5">
      <i class="bi bi-${icon} display-5 d-block mb-2 opacity-50"></i><div class="fw-semibold">${esc(title)}</div>
      <div class="small">${esc(text)}</div>${extra}</div>`;
  const countdown = (d, reload = true) => `<span class="sp-countdown" data-countdown="${d.toISOString()}" ${reload ? 'data-reload="1"' : ""}></span>`;

  // v_reservation_details
  function details(r) {
    const u = E.user(r.user_id), v = E.vehicle(r.vehicle_id), s = E.slot(r.slot_id), l = E.location(s.location_id), c = E.chargerOfSlot(s.slot_id);
    return { ...r, full_name: u.full_name, email: u.email, registration_no: v.registration_no, model_name: v.model_name,
             slot_code: s.slot_code, slot_type: s.slot_type, floor_level: s.floor_level, location_id: l.location_id,
             location_name: l.name, city: l.city, charger_type: c ? c.charger_type : null,
             connector_type: c ? c.connector_type : null, power_kw: c ? c.power_kw : null };
  }

  function formData(form) {
    const o = {};
    new FormData(form).forEach((v, k) => { o[k] = typeof v === "string" ? v.trim() : v; });
    form.querySelectorAll('input[type="checkbox"]').forEach((cb) => { o[cb.name] = cb.checked; });
    return o;
  }

  // Validate with the browser, then run handler(data)
  function onSubmit(selector, handler) {
    document.querySelectorAll(selector).forEach((form) => form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (form.dataset.confirm && !confirm(form.dataset.confirm)) return;
      if (!form.checkValidity()) { form.classList.add("was-validated"); return; }
      handler(formData(form), form);
    }));
  }

  // ------------------------------------------------------------ live countdowns + "scheduler"
  function tickCountdowns() {
    document.querySelectorAll("[data-countdown]").forEach((el) => {
      const ms = new Date(el.dataset.countdown) - new Date();
      if (ms <= 0) { el.textContent = "expired"; el.classList.add("text-danger"); return; }
      el.textContent = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
    });
  }

  // The browser equivalent of scripts/scheduler.py: run the expiry job every 15 s.
  function schedulerTick() {
    const r = E.runExpiryJobs();
    const changed = r.expired_holds + r.no_shows + r.expired_waits + r.offers_made;
    const typing = document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
    const modalOpen = document.querySelector(".modal.show");
    if (changed && !typing && !modalOpen) {
      flash(`Scheduler: ${r.expired_holds} hold(s) expired, ${r.no_shows} no-show(s), ${r.expired_waits} waiting entr(ies) expired, ${r.offers_made} offer(s) made.`, "info");
      render();
    }
  }

  function start() {
    window.SPSEED.seed();
    window.addEventListener("hashchange", render);
    setInterval(tickCountdowns, 1000);
    setInterval(schedulerTick, 15000);
    render();
  }

  window.SPAPP = {
    REPO_URL, state, route, go, flash, act, toast, render, currentUser, isAdmin, badge, badgeColor, slotIcon,
    chargerLabel, empty, countdown, details, formData, onSubmit, errorView, start, fmt,
  };
})();
