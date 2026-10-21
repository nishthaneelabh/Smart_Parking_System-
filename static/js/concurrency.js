// Admin concurrency demo: asks the server to run two simultaneous bookings and shows the timeline.
(() => {
  const form = document.getElementById("demo-form");
  const out = document.getElementById("d-output");
  const btn = document.getElementById("d-run");

  function resultCard(r) {
    if (!r) return "";
    const ok = r.ok;
    return `<div class="col-md-6"><div class="border rounded-3 p-3 h-100 ${ok ? "border-success bg-success-subtle" : "border-danger bg-danger-subtle"}">
      <div class="d-flex justify-content-between"><strong>${SP.esc(r.label)} — ${SP.esc(r.user)}</strong>
        <span class="badge text-bg-${ok ? "success" : "danger"}">${ok ? "BOOKED" : "REJECTED"}</span></div>
      <div class="small mt-1">PostgreSQL backend pid <code>${r.backend_pid ?? "?"}</code></div>
      <div class="small">Waited for lock: <strong>${r.waited_ms ?? 0} ms</strong></div>
      ${ok ? `<div class="small">Reservation <strong>#${r.reservation_id}</strong> (HELD)</div>`
           : `<div class="small text-danger-emphasis"><code>${SP.esc(r.error_code)}</code>: ${SP.esc(r.error)}</div>`}
    </div></div>`;
  }

  function render(d) {
    const good = d.double_booking_prevented;
    out.innerHTML = `
      <div class="sp-verdict mb-3 ${good ? "bg-success-subtle border border-success" : "bg-danger-subtle border border-danger"}">
        <div class="h5 fw-bold mb-1">${good ? '<i class="bi bi-shield-check"></i> Double booking prevented' : '<i class="bi bi-x-octagon"></i> DOUBLE BOOKING DETECTED'}</div>
        <div class="small">Successful bookings: <strong>${d.successful_bookings}</strong> ·
          Active overlapping rows in <code>reservations</code> for this slot &amp; time: <strong>${d.active_overlapping_rows}</strong> ·
          Mode: <code>${SP.esc(d.mode)}</code>${d.cleaned_up.length ? ` · cleaned up #${d.cleaned_up.join(", #")}` : ""}</div>
      </div>
      <div class="row g-3 mb-3">${resultCard(d.results[0])}${resultCard(d.results[1])}</div>
      <div class="fw-bold mb-2">Timeline (ms since start)</div>
      <div class="sp-timeline">
        ${d.events.map((e) => `<div class="ev ${e.who === "User A" ? "row-a" : "row-b"}">
          <span class="text-muted">${e.t_ms.toFixed(1).padStart(7, " ")} ms</span> · <strong>${SP.esc(e.who)}</strong> · ${SP.esc(e.msg)}</div>`).join("")}
      </div>`;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Racing…`;
    out.innerHTML = `<div class="text-center py-5"><div class="spinner-border text-info"></div><div class="small sp-muted mt-2">Two transactions are competing for the same row lock…</div></div>`;
    try {
      const d = await SP.api(SP_DEMO_URL, {
        method: "POST",
        body: {
          slot_id: document.getElementById("d-slot").value,
          start: document.getElementById("d-start").value,
          end: document.getElementById("d-end").value,
          hold_seconds: document.getElementById("d-hold").value,
          nowait: document.getElementById("d-nowait").checked,
          cleanup: document.getElementById("d-cleanup").checked,
        },
      });
      render(d);
    } catch (err) {
      out.innerHTML = `<div class="alert alert-danger mb-0">${SP.esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="bi bi-lightning-charge"></i> Run simultaneous booking`;
    }
  });
})();
