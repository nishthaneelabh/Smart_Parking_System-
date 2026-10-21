// Find & Book page: search available slots, reserve one, or join the waiting list.
(() => {
  const form = document.getElementById("search-form");
  const results = document.getElementById("results");
  const header = document.getElementById("results-header");
  const title = document.getElementById("results-title");
  const modal = new bootstrap.Modal(document.getElementById("bookModal"));
  const confirmBtn = document.getElementById("book-confirm");
  let chosen = null;
  let lastQuery = null;

  const val = (id) => document.getElementById(id).value;
  const fmt = (iso) => new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  function query() {
    return {
      vehicle_id: val("vehicle_id"), location_id: val("location_id"), slot_type: val("slot_type"),
      charger_type: val("charger_type"), start: val("start"), end: val("end"),
    };
  }

  async function search(e) {
    if (e) e.preventDefault();
    if (!form.checkValidity()) { form.classList.add("was-validated"); return; }
    lastQuery = query();
    results.innerHTML = `<div class="col-12 text-center py-5"><div class="spinner-border text-info"></div></div>`;
    header.classList.add("d-none");
    try {
      const data = await SP.api(`${SP_URLS.search}?${new URLSearchParams(lastQuery)}`);
      render(data.slots);
    } catch (err) {
      results.innerHTML = `<div class="col-12"><div class="alert alert-danger">${SP.esc(err.message)}</div></div>`;
    }
  }

  function render(slots) {
    header.classList.remove("d-none");
    title.textContent = `${slots.length} slot${slots.length === 1 ? "" : "s"} available`;
    if (!slots.length) {
      renderEmpty();
      return;
    }
    results.innerHTML = slots.map((s, i) => `
      <div class="col-md-6 col-xl-4 sp-fade-in" style="animation-delay:${Math.min(i, 12) * 30}ms">
        <div class="sp-card sp-card-hover p-3 h-100 d-flex flex-column">
          <div class="d-flex gap-3 align-items-center mb-2">
            <span class="sp-slot-icon ${s.slot_type === "EV" ? "sp-ev" : ""}"><i class="bi bi-${s.slot_type === "EV" ? "ev-station" : "p-square"}"></i></span>
            <div class="flex-grow-1">
              <div class="fw-bold">${SP.esc(s.location_name)} · ${SP.esc(s.slot_code)}</div>
              <div class="small sp-muted">${SP.esc(s.city)} · Floor ${s.floor_level} · ${SP.esc(s.size_class)} size</div>
            </div>
            <span class="badge text-bg-${s.occupancy_status === "FREE" ? "success" : "secondary"}" title="Physical status right now">${s.occupancy_status === "FREE" ? "Free now" : "Occupied now"}</span>
          </div>
          ${s.charger_type ? `<div class="mb-2">
              <span class="badge rounded-pill ${s.charger_type === "DC" ? "text-bg-danger" : "text-bg-info"}">${s.charger_type}${s.charger_type === "DC" ? " Fast" : ""} · ${Number(s.power_kw)} kW</span>
              <span class="badge rounded-pill text-bg-light border">${SP.esc(s.connector_type.replace("_", " "))}</span></div>` : ""}
          <div class="small sp-muted mb-3">Parking ${SP.inr(s.est_parking_fee)}${s.charger_type ? ` + charging ${SP.inr(s.est_charging_fee)}` : ""}</div>
          <div class="mt-auto d-flex justify-content-between align-items-center">
            <span class="sp-price">${SP.inr(s.est_total)}</span>
            <button class="btn btn-teal btn-sm" data-idx="${i}"><i class="bi bi-lock"></i> Reserve</button>
          </div>
        </div>
      </div>`).join("");
    results.querySelectorAll("button[data-idx]").forEach((b) =>
      b.addEventListener("click", () => openModal(slots[b.dataset.idx])));
  }

  function renderEmpty() {
    const q = lastQuery;
    const canWait = q.location_id && q.slot_type;
    results.innerHTML = `
      <div class="col-12"><div class="sp-card p-5 text-center">
        <i class="bi bi-emoji-frown display-5 sp-muted"></i>
        <h3 class="h5 fw-bold mt-2">No compatible slot is free for this time</h3>
        ${canWait
          ? `<p class="sp-muted">Join the priority waiting list — when a matching slot frees up, you'll get a 10-minute offer to pay and confirm.</p>
             <button class="btn btn-primary" id="join-wait"><i class="bi bi-hourglass-split"></i> Join waiting list</button>`
          : `<p class="sp-muted">To join the waiting list, pick a specific <strong>location</strong> and <strong>slot type</strong> and search again.</p>`}
      </div></div>`;
    const btn = document.getElementById("join-wait");
    if (btn) btn.addEventListener("click", joinWaitlist);
  }

  async function joinWaitlist() {
    try {
      const data = await SP.api(SP_URLS.waitlist, { method: "POST", body: lastQuery });
      SP.toast(`Added to the waiting list (entry #${data.entry_id}).`);
      setTimeout(() => (location.href = data.redirect), 800);
    } catch (err) {
      SP.toast(err.message, "danger");
    }
  }

  function openModal(slot) {
    chosen = slot;
    const veh = document.getElementById("vehicle_id");
    document.getElementById("book-summary").innerHTML = `
      <dl class="row mb-0">
        <dt class="col-4">Location</dt><dd class="col-8">${SP.esc(slot.location_name)}, ${SP.esc(slot.city)}</dd>
        <dt class="col-4">Slot</dt><dd class="col-8">${SP.esc(slot.slot_code)} (${slot.slot_type}${slot.charger_type ? ", " + slot.charger_type + " " + Number(slot.power_kw) + " kW" : ""})</dd>
        <dt class="col-4">Vehicle</dt><dd class="col-8">${SP.esc(veh.options[veh.selectedIndex].text)}</dd>
        <dt class="col-4">From</dt><dd class="col-8">${fmt(lastQuery.start)}</dd>
        <dt class="col-4">Until</dt><dd class="col-8">${fmt(lastQuery.end)}</dd>
        <dt class="col-4">Estimated</dt><dd class="col-8 sp-price">${SP.inr(slot.est_total)}</dd>
      </dl>
      <div class="alert alert-light border small mt-3 mb-0">
        <i class="bi bi-info-circle"></i> The slot is <strong>held for 10 minutes</strong> while you pay.
        The final price is recalculated by the database at booking time.
      </div>`;
    modal.show();
  }

  confirmBtn.addEventListener("click", async () => {
    if (!chosen) return;
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Reserving…`;
    try {
      const data = await SP.api(SP_URLS.reserve, {
        method: "POST",
        body: { slot_id: chosen.slot_id, vehicle_id: lastQuery.vehicle_id, start: lastQuery.start, end: lastQuery.end },
      });
      SP.toast(`Slot held! Reservation #${data.reservation_id}. Complete payment to confirm.`);
      location.href = data.redirect;
    } catch (err) {
      modal.hide();
      SP.toast(err.code === "SLOT_UNAVAILABLE" || err.code === "SLOT_BUSY"
        ? `Slot Unavailable — someone else just booked it. Showing fresh results.` : err.message, "danger");
      search();
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = `<i class="bi bi-lock"></i> Reserve now`;
    }
  });

  form.addEventListener("submit", search);
  // EV-only filter helper: choosing a charger implies an EV slot
  document.getElementById("charger_type").addEventListener("change", (e) => {
    if (e.target.value) document.getElementById("slot_type").value = "EV";
  });
  if (document.getElementById("vehicle_id").value) search();
})();
