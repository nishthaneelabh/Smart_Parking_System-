// Shared helpers used by every page.
const SP = (() => {
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || "";

  // fetch() wrapper: sends the CSRF header, parses JSON, throws {code, message} on error.
  async function api(url, { method = "GET", body } = {}) {
    const opts = { method, headers: { "X-CSRF-Token": csrf(), Accept: "application/json" } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res, data;
    try {
      res = await fetch(url, opts);
      data = await res.json();
    } catch (e) {
      throw { code: "NETWORK", message: "Could not reach the server. Is Flask running?" };
    }
    if (!res.ok || data.ok === false) {
      throw data.error || { code: "ERROR", message: `Request failed (${res.status})` };
    }
    return data;
  }

  function toast(message, type = "success") {
    const area = document.getElementById("toast-area");
    const el = document.createElement("div");
    el.className = `toast align-items-center text-bg-${type} border-0`;
    el.setAttribute("role", "alert");
    el.innerHTML = `<div class="d-flex"><div class="toast-body"></div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
    el.querySelector(".toast-body").textContent = message;
    area.appendChild(el);
    const t = new bootstrap.Toast(el, { delay: 6000 });
    t.show();
    el.addEventListener("hidden.bs.toast", () => el.remove());
  }

  const inr = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Live countdown for any element with data-countdown="ISO time"
  function startCountdowns() {
    const els = document.querySelectorAll("[data-countdown]");
    if (!els.length) return;
    const tick = () => {
      els.forEach((el) => {
        const ms = new Date(el.dataset.countdown) - new Date();
        if (ms <= 0) {
          el.textContent = "expired";
          el.classList.add("text-danger");
          if (el.dataset.reloadOnExpire && !el.dataset.reloaded) {
            el.dataset.reloaded = "1";
            setTimeout(() => location.reload(), 1500);
          }
          return;
        }
        const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
        el.textContent = `${m}:${String(s).padStart(2, "0")}`;
      });
    };
    tick();
    setInterval(tick, 1000);
  }

  // Bootstrap form validation styling
  function enableValidation() {
    document.querySelectorAll("form.needs-validation").forEach((form) => {
      form.addEventListener("submit", (e) => {
        if (!form.checkValidity()) { e.preventDefault(); e.stopPropagation(); }
        form.classList.add("was-validated");
      });
    });
  }

  // Ask before destructive actions: <form data-confirm="Are you sure?">
  function enableConfirms() {
    document.querySelectorAll("form[data-confirm]").forEach((form) => {
      form.addEventListener("submit", (e) => { if (!confirm(form.dataset.confirm)) e.preventDefault(); });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    startCountdowns();
    enableValidation();
    enableConfirms();
  });

  return { api, toast, inr, esc };
})();
