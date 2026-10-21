// In-browser "database" for the static demo.
//
// This is a JavaScript port of database/functions.sql, triggers.sql and
// procedures.sql: same rules, same error codes, same messages. All data
// lives in memory, so refreshing the page resets everything.
//
// What it CANNOT do is real concurrency — a browser tab is single-threaded
// and there is no database server. The Concurrency page therefore replays
// results recorded from PostgreSQL (js/recorded-concurrency.js).
(function () {
  const { MIN, HOUR, DAY, ist, round2 } = window.SPU;

  const ACTIVE = ["HELD", "CONFIRMED", "CHECKED_IN"];
  const SIZE = { BIKE: 1, CAR: 2, SUV: 3 };
  const now = () => new Date();

  class DemoError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const fail = (code, message) => { throw new DemoError(code, message); };

  // ---------------------------------------------------------------- tables
  const DB = {
    users: [], vehicles: [], locations: [], slots: [], chargers: [], maintenance: [],
    pricingRules: [], peakHours: [], reservations: [], waitingList: [], payments: [], audit: [],
    policy: {
      hold_minutes: 10, waitlist_offer_minutes: 10, grace_minutes: 15, overstay_multiplier: 2.0,
      no_show_minutes: 30, early_checkin_minutes: 15, min_booking_minutes: 30,
      max_booking_hours: 24, max_advance_days: 30,
    },
    seq: {},
  };
  const nextId = (t) => (DB.seq[t] = (DB.seq[t] || 0) + 1);
  const byId = (table, key, id) => DB[table].find((r) => r[key] === Number(id));

  const user = (id) => byId("users", "user_id", id);
  const vehicle = (id) => byId("vehicles", "vehicle_id", id);
  const location = (id) => byId("locations", "location_id", id);
  const slot = (id) => byId("slots", "slot_id", id);
  const charger = (id) => byId("chargers", "charger_id", id);
  const chargerOfSlot = (slotId) => DB.chargers.find((c) => c.slot_id === Number(slotId));
  const reservation = (id) => byId("reservations", "reservation_id", id);
  const entry = (id) => byId("waitingList", "entry_id", id);

  const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;          // [start, end) ranges
  const connectorCompatible = (v, c) => v === c || (v === "CCS2" && c === "TYPE2");
  // An expired HELD row no longer blocks a slot (same as the SQL search)
  const blocking = (r, t = now()) => ACTIVE.includes(r.status) && !(r.status === "HELD" && r.hold_expires_at <= t);

  // -------------------------------------------------------------- audit log (tf_audit_status)
  function audit(table, id, action, oldStatus, newStatus, details = "") {
    DB.audit.push({ log_id: nextId("audit"), table_name: table, record_id: id, action,
                    old_status: oldStatus || null, new_status: newStatus, details, changed_at: now() });
  }

  // ================================================================ PRICING
  function getRate(locationId, appliesTo) {
    const rules = DB.pricingRules.filter((r) => r.is_active && r.applies_to === appliesTo &&
                                                (r.location_id === locationId || r.location_id === null));
    rules.sort((a, b) => (a.location_id === null) - (b.location_id === null));     // location-specific first
    if (!rules.length) fail("NO_PRICING_RULE", `No active pricing rule for ${appliesTo} at location ${locationId}`);
    return rules[0].rate_per_hour;
  }

  function peakMultiplier(t) {
    const p = ist(t);
    const minutes = p.h * 60 + p.mi;
    let mult = 1;
    for (const w of DB.peakHours) {
      const dayOk = w.day_type === "ALL" || (w.day_type === "WEEKEND" && p.isoDow >= 6) ||
                    (w.day_type === "WEEKDAY" && p.isoDow <= 5);
      if (dayOk && minutes >= w.start_min && minutes < w.end_min) mult = Math.max(mult, w.multiplier);
    }
    return mult;
  }

  // fn_calculate_price: 15-minute pieces × rate × peak multiplier
  function calculatePrice(locationId, slotType, chargerType, start, end) {
    if (!(end > start)) fail("INVALID_TIME", "End time must be after start time");
    const parkRate = getRate(locationId, "PARKING");
    let chargeRate = 0;
    if (slotType === "EV") {
      if (!["AC", "DC"].includes(chargerType)) fail("INVALID_CHARGER", "EV slot price needs charger type AC or DC");
      chargeRate = getRate(locationId, chargerType);
    }
    let park = 0, charge = 0, peak = 0, off = 0;
    for (let t = start.getTime(); t < end.getTime(); t += 15 * MIN) {
      const minutes = (Math.min(t + 15 * MIN, end.getTime()) - t) / MIN;
      const mult = peakMultiplier(new Date(t));
      park += parkRate * minutes / 60 * mult;
      charge += chargeRate * minutes / 60 * mult;
      if (mult > 1) peak += minutes; else off += minutes;
    }
    park = round2(park); charge = round2(charge);
    return { parking_fee: park, charging_fee: charge, total: round2(park + charge), peak_minutes: peak, offpeak_minutes: off };
  }

  // ================================================================ SEARCH
  function searchSlots({ start, end, locationId = null, city = null, slotType = null, chargerType = null, vehicleId = null }) {
    if (!start || !end || !(end > start)) fail("INVALID_TIME", "Please choose a valid start and end time");
    const v = vehicleId ? vehicle(vehicleId) : null;
    const rows = [];
    for (const s of DB.slots) {
      const l = location(s.location_id);
      const c = chargerOfSlot(s.slot_id);
      if (!s.is_active || !l.is_active) continue;
      if (locationId && s.location_id !== Number(locationId)) continue;
      if (city && l.city.toLowerCase() !== city.toLowerCase()) continue;
      if (slotType && s.slot_type !== slotType) continue;
      if (chargerType && (!c || c.charger_type !== chargerType)) continue;
      if (s.slot_type === "EV" && (!c || c.status !== "OPERATIONAL")) continue;
      if (v) {
        if (SIZE[v.vehicle_type] > SIZE[s.size_class]) continue;
        if (s.slot_type === "EV" && !(v.is_ev && connectorCompatible(v.connector_type, c.connector_type))) continue;
      }
      if (DB.reservations.some((r) => r.slot_id === s.slot_id && blocking(r) && overlaps(r.start_time, r.end_time, start, end))) continue;
      const p = calculatePrice(s.location_id, s.slot_type, c && c.charger_type, start, end);
      rows.push({ ...s, location_name: l.name, city: l.city, charger_id: c ? c.charger_id : null,
                  charger_type: c ? c.charger_type : null, connector_type: c ? c.connector_type : null,
                  power_kw: c ? c.power_kw : null, est_parking_fee: p.parking_fee,
                  est_charging_fee: p.charging_fee, est_total: p.total });
    }
    rows.sort((a, b) => a.location_name.localeCompare(b.location_name) ||
                        b.slot_type.localeCompare(a.slot_type) || a.slot_code.localeCompare(b.slot_code));
    return rows;
  }

  // ================================================================ STATUS CHANGES + TRIGGERS
  // Every status change of a reservation goes through here, exactly like an
  // UPDATE in PostgreSQL that fires the reservation triggers.
  function setReservationStatus(r, status, fields = {}) {
    const old = r.status;
    Object.assign(r, fields);
    r.status = status;
    r.updated_at = now();

    // Trigger A (BEFORE UPDATE) — overstay fine when the booking is completed
    if (status === "COMPLETED" && old !== "COMPLETED") {
      const graceEnd = r.end_time.getTime() + DB.policy.grace_minutes * MIN;
      if (r.check_out_time.getTime() > graceEnd) {
        const hours = Math.ceil((r.check_out_time - r.end_time) / HOUR);
        const rate = getRate(slot(r.slot_id).location_id, "PARKING");
        r.overstay_fine = round2(hours * rate * DB.policy.overstay_multiplier);
      } else {
        r.overstay_fine = 0;
      }
    }
    r.total_amount = round2(r.parking_fee + r.charging_fee + r.overstay_fine);   // generated column

    if (old === status) return;
    // Trigger B (AFTER UPDATE) — physical occupancy follows check-in / check-out only
    if (status === "CHECKED_IN") slot(r.slot_id).occupancy_status = "OCCUPIED";
    else if (old === "CHECKED_IN") slot(r.slot_id).occupancy_status = "FREE";

    // trg_res_waitlist_sync — a waiting-list offer was paid / expired / declined
    if (r.source === "WAITLIST" && old === "HELD" && ["CONFIRMED", "EXPIRED", "CANCELLED"].includes(status)) {
      const e = DB.waitingList.find((w) => w.offered_reservation_id === r.reservation_id && w.status === "OFFERED");
      if (e) setEntryStatus(e, status === "CONFIRMED" ? "ACCEPTED" : status === "EXPIRED" ? "EXPIRED" : "CANCELLED");
    }
    audit("reservations", r.reservation_id, "UPDATE", old, status, r.cancel_reason || "");
  }

  function setEntryStatus(e, status, fields = {}) {
    const old = e.status;
    Object.assign(e, fields, { status, updated_at: now() });
    if (old !== status) audit("waiting_list", e.entry_id, "UPDATE", old, status);
  }

  function setPaymentStatus(p, status) {
    const old = p.status;
    p.status = status;
    if (status === "REFUNDED") p.refunded_at = now();
    audit("payments", p.payment_id, "UPDATE", old, status);
  }

  // Trigger C — faulty / repaired charger
  function setChargerStatus(c, status) {
    const old = c.status;
    if (old === status) return;
    c.status = status;
    audit("chargers", c.charger_id, "UPDATE", old, status);
    const s = slot(c.slot_id);
    if (status === "FAULTY") {
      if (!DB.maintenance.some((m) => m.charger_id === c.charger_id && !m.resolved_at)) {
        DB.maintenance.push({ maintenance_id: nextId("maintenance"), charger_id: c.charger_id,
                              issue_description: "Charger marked FAULTY", reported_by: null,
                              reported_at: now(), resolved_at: null, resolution_note: null });
      }
      for (const r of DB.reservations.filter((x) => x.slot_id === s.slot_id && ["HELD", "CONFIRMED"].includes(x.status) && x.end_time > now())) {
        setReservationStatus(r, "CANCELLED", { cancel_reason: "Charger fault — booking cancelled with full refund" });
        DB.payments.filter((p) => p.reservation_id === r.reservation_id && p.status === "SUCCESS")
                   .forEach((p) => setPaymentStatus(p, "REFUNDED"));
        if (r.start_time > now()) {
          const dup = DB.waitingList.some((w) => w.vehicle_id === r.vehicle_id && ["WAITING", "OFFERED"].includes(w.status) &&
                                                 overlaps(w.start_time, w.end_time, r.start_time, r.end_time));
          if (!dup) insertEntry({ user_id: r.user_id, vehicle_id: r.vehicle_id, location_id: s.location_id,
                                  slot_type: "EV", charger_type: c.charger_type, start_time: r.start_time,
                                  end_time: r.end_time, priority: 4 });
        }
      }
    } else if (old === "FAULTY" && status === "OPERATIONAL") {
      DB.maintenance.filter((m) => m.charger_id === c.charger_id && !m.resolved_at)
        .forEach((m) => { m.resolved_at = now(); m.resolution_note = m.resolution_note || "Charger repaired"; });
    }
  }

  function insertEntry(fields) {
    const e = { entry_id: nextId("waitingList"), charger_type: null, priority: 1, status: "WAITING",
                requested_at: now(), offered_reservation_id: null, offered_at: null, updated_at: now(), ...fields };
    DB.waitingList.push(e);
    audit("waiting_list", e.entry_id, "INSERT", null, e.status);
    return e;
  }

  // ================================================================ SAFE RESERVATION (fn_create_reservation)
  function createReservation(userId, vehicleId, slotId, start, end, source = "DIRECT") {
    const pol = DB.policy;
    if (!start || !end || !(end > start)) fail("INVALID_TIME", "End time must be after start time");
    if (start < now() - 5 * MIN) fail("INVALID_TIME", "Start time cannot be in the past");
    if (end - start < pol.min_booking_minutes * MIN) fail("INVALID_TIME", `Minimum booking is ${pol.min_booking_minutes} minutes`);
    if (end - start > pol.max_booking_hours * HOUR) fail("INVALID_TIME", `Maximum booking is ${pol.max_booking_hours} hours`);
    if (start > now().getTime() + pol.max_advance_days * DAY) fail("INVALID_TIME", `You can book at most ${pol.max_advance_days} days in advance`);

    const v = vehicle(vehicleId);
    if (!v || v.user_id !== Number(userId)) fail("VEHICLE_NOT_OWNED", "This vehicle is not registered to your account");

    // (In PostgreSQL: SELECT ... FROM parking_slots WHERE slot_id = $1 FOR UPDATE)
    const s = slot(slotId);
    if (!s) fail("SLOT_NOT_FOUND", `Slot ${slotId} does not exist`);
    if (!s.is_active || !location(s.location_id).is_active) fail("SLOT_INACTIVE", "This slot is currently closed for bookings");
    if (SIZE[v.vehicle_type] > SIZE[s.size_class]) fail("VEHICLE_INCOMPATIBLE", `A ${v.vehicle_type} does not fit in a ${s.size_class}-size slot`);

    const c = chargerOfSlot(s.slot_id);
    if (s.slot_type === "EV") {
      if (!c) fail("CHARGER_FAULTY", "This EV slot has no charger installed");
      if (c.status !== "OPERATIONAL") fail("CHARGER_FAULTY", "The charger at this slot is faulty and cannot be booked");
      if (!v.is_ev) fail("VEHICLE_INCOMPATIBLE", "EV charging slots are reserved for electric vehicles");
      if (!connectorCompatible(v.connector_type, c.connector_type))
        fail("VEHICLE_INCOMPATIBLE", `Your vehicle uses ${v.connector_type} but this charger has ${c.connector_type}`);
    }

    // Release holds on this slot whose payment window has passed
    DB.reservations.filter((r) => r.slot_id === s.slot_id && r.status === "HELD" && r.hold_expires_at <= now())
      .forEach((r) => setReservationStatus(r, "EXPIRED", { cancel_reason: "Payment not received before hold expired" }));

    if (DB.reservations.some((r) => r.slot_id === s.slot_id && ACTIVE.includes(r.status) && overlaps(r.start_time, r.end_time, start, end)))
      fail("SLOT_UNAVAILABLE", "Slot Unavailable: it is already reserved for an overlapping time");
    if (DB.reservations.some((r) => r.vehicle_id === v.vehicle_id && blocking(r) && overlaps(r.start_time, r.end_time, start, end)))
      fail("VEHICLE_ALREADY_BOOKED", "This vehicle already has a reservation during this time");

    const price = calculatePrice(s.location_id, s.slot_type, c && c.charger_type, start, end);
    const holdMin = source === "WAITLIST" ? pol.waitlist_offer_minutes : pol.hold_minutes;
    const r = {
      reservation_id: nextId("reservations"), user_id: Number(userId), vehicle_id: v.vehicle_id, slot_id: s.slot_id,
      start_time: start, end_time: end, status: "HELD", source, hold_expires_at: new Date(now().getTime() + holdMin * MIN),
      parking_fee: price.parking_fee, charging_fee: price.charging_fee, overstay_fine: 0, total_amount: price.total,
      check_in_time: null, check_out_time: null, cancel_reason: null, created_at: now(), updated_at: now(),
    };
    DB.reservations.push(r);
    audit("reservations", r.reservation_id, "INSERT", null, "HELD");
    return r.reservation_id;
  }

  // ================================================================ BILLING / PAYMENT / CANCEL / CHECK-IN / CHECK-OUT
  function finalBill(id) {
    const r = reservation(id);
    const pays = DB.payments.filter((p) => p.reservation_id === r.reservation_id);
    const paid = round2(pays.filter((p) => p.status === "SUCCESS").reduce((a, p) => a + p.amount, 0));
    const refunded = round2(pays.filter((p) => p.status === "REFUNDED").reduce((a, p) => a + p.amount, 0));
    return {
      reservation_id: r.reservation_id, status: r.status, parking_fee: r.parking_fee, charging_fee: r.charging_fee,
      overstay_fine: r.overstay_fine, total_amount: r.total_amount, amount_paid: paid, amount_refunded: refunded,
      balance_due: ["CANCELLED", "EXPIRED"].includes(r.status) ? 0 : Math.max(round2(r.total_amount - paid), 0),
      overstay_minutes: r.check_out_time && r.check_out_time > r.end_time ? Math.ceil((r.check_out_time - r.end_time) / MIN) : 0,
    };
  }

  function ownReservation(id, userId, isAdmin) {
    const r = reservation(id);
    if (!r || (r.user_id !== Number(userId) && !isAdmin)) fail("RESERVATION_NOT_FOUND", "Reservation not found");
    return r;
  }

  function makePayment(id, userId, method, isAdmin = false, simulateFailure = false) {
    if (!["UPI", "CARD", "NETBANKING", "WALLET"].includes(method)) fail("INVALID_METHOD", "Choose UPI, CARD, NETBANKING or WALLET");
    const r = ownReservation(id, userId, isAdmin);
    let amount, type;
    if (r.status === "HELD") {
      if (r.hold_expires_at <= now()) fail("HOLD_EXPIRED", "Your hold has expired. Please search and book again.");
      amount = round2(r.parking_fee + r.charging_fee); type = "BOOKING";
    } else if (r.status === "COMPLETED") {
      amount = finalBill(id).balance_due;
      if (amount <= 0) fail("NOTHING_TO_PAY", "This reservation has no outstanding balance");
      type = "FINE";
    } else {
      fail("INVALID_STATE", `Cannot pay for a reservation in status ${r.status}`);
    }
    const ref = "SIM-" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    const pay = (status) => {
      const p = { payment_id: nextId("payments"), reservation_id: r.reservation_id, amount: Math.max(amount, 0.01),
                  payment_type: type, method, status, transaction_ref: ref, paid_at: now(), refunded_at: null };
      DB.payments.push(p);
      audit("payments", p.payment_id, "INSERT", null, status);
      return p.payment_id;
    };
    if (simulateFailure) return pay("FAILED");
    const pid = amount > 0 ? pay("SUCCESS") : null;
    if (r.status === "HELD") setReservationStatus(r, "CONFIRMED");
    return pid;
  }

  function cancelReservation(id, userId, isAdmin = false, reason = "Cancelled by user") {
    const r = ownReservation(id, userId, isAdmin);
    if (!["HELD", "CONFIRMED"].includes(r.status)) fail("CANNOT_CANCEL", `A ${r.status} reservation cannot be cancelled`);
    if (r.start_time <= now() && !isAdmin) fail("CANNOT_CANCEL", "This reservation has already started and can no longer be cancelled");
    setReservationStatus(r, "CANCELLED", { cancel_reason: reason || "Cancelled" });
    let refund = 0;
    DB.payments.filter((p) => p.reservation_id === r.reservation_id && p.status === "SUCCESS")
      .forEach((p) => { refund += p.amount; setPaymentStatus(p, "REFUNDED"); });
    processWaitingList();
    return round2(refund);
  }

  function checkIn(id, userId, isAdmin = false) {
    const pol = DB.policy;
    const r = ownReservation(id, userId, isAdmin);
    if (r.status !== "CONFIRMED") fail("INVALID_STATE", `Only CONFIRMED reservations can check in (this one is ${r.status})`);
    if (now() < r.start_time - pol.early_checkin_minutes * MIN) fail("TOO_EARLY", `Check-in opens ${pol.early_checkin_minutes} minutes before your start time`);
    if (now() > r.start_time.getTime() + pol.no_show_minutes * MIN) fail("TOO_LATE", "The check-in window has closed (no-show)");
    if (slot(r.slot_id).occupancy_status === "OCCUPIED") fail("SLOT_OCCUPIED", "The previous vehicle has not left the slot yet. Please contact staff.");
    setReservationStatus(r, "CHECKED_IN", { check_in_time: now() });
    return r.check_in_time;
  }

  function checkOut(id, userId, isAdmin = false, checkoutTime = null) {
    const r = ownReservation(id, userId, isAdmin);
    if (r.status !== "CHECKED_IN") fail("INVALID_STATE", `Only CHECKED_IN reservations can check out (this one is ${r.status})`);
    const t = isAdmin && checkoutTime ? checkoutTime : now();
    if (t < r.check_in_time) fail("INVALID_TIME", "Check-out time cannot be before check-in time");
    setReservationStatus(r, "COMPLETED", { check_out_time: t });
    processWaitingList();
    return finalBill(id);
  }

  // ================================================================ WAITING LIST
  function userPriority(userId) {
    const u = user(userId);
    return u.has_accessibility_permit ? 3 : u.membership_tier === "PREMIUM" ? 2 : 1;
  }
  const PRIORITY_LABEL = { 4: "SERVICE RECOVERY", 3: "ACCESSIBILITY", 2: "PREMIUM", 1: "STANDARD" };
  const queueOrder = (a, b) => b.priority - a.priority || a.requested_at - b.requested_at || a.entry_id - b.entry_id;

  function joinWaitingList(userId, vehicleId, locationId, slotType, chargerType, start, end) {
    if (!start || !end || !(end > start)) fail("INVALID_TIME", "End time must be after start time");
    if (start <= now()) fail("INVALID_TIME", "You can only wait for a future time window");
    const v = vehicle(vehicleId);
    if (!v || v.user_id !== Number(userId)) fail("VEHICLE_NOT_OWNED", "This vehicle is not registered to your account");
    if (!location(locationId)) fail("LOCATION_NOT_FOUND", "Unknown location");
    if (!["REGULAR", "EV"].includes(slotType)) fail("INVALID_INPUT", "Slot type must be REGULAR or EV");
    if (slotType === "EV" && !v.is_ev) fail("VEHICLE_INCOMPATIBLE", "Only electric vehicles can wait for EV charging slots");
    if (slotType === "REGULAR") chargerType = null;
    const free = searchSlots({ start, end, locationId, slotType, chargerType, vehicleId }).length;
    if (free > 0) fail("SLOTS_AVAILABLE", `${free} compatible slot(s) are free for this time — please book directly`);
    if (DB.waitingList.some((w) => w.vehicle_id === v.vehicle_id && ["WAITING", "OFFERED"].includes(w.status) &&
                                   overlaps(w.start_time, w.end_time, start, end)))
      fail("ALREADY_WAITING", "This vehicle is already on the waiting list for an overlapping time");
    const e = insertEntry({ user_id: Number(userId), vehicle_id: v.vehicle_id, location_id: Number(locationId),
                            slot_type: slotType, charger_type: chargerType || null, start_time: start, end_time: end,
                            priority: userPriority(userId) });
    processWaitingList();
    return e.entry_id;
  }

  function processWaitingList(maxOffers = 100) {
    let offers = 0;
    const queue = DB.waitingList.filter((w) => w.status === "WAITING" && w.start_time > now()).sort(queueOrder);
    for (const e of queue) {
      if (offers >= maxOffers) break;
      const v = vehicle(e.vehicle_id);
      const candidates = DB.slots.filter((s) => {
        const c = chargerOfSlot(s.slot_id);
        return s.location_id === e.location_id && s.slot_type === e.slot_type && s.is_active &&
               location(s.location_id).is_active && SIZE[v.vehicle_type] <= SIZE[s.size_class] &&
               (s.slot_type === "REGULAR" || (c && c.status === "OPERATIONAL" && connectorCompatible(v.connector_type, c.connector_type) &&
                                              (!e.charger_type || c.charger_type === e.charger_type))) &&
               !DB.reservations.some((r) => r.slot_id === s.slot_id && blocking(r) && overlaps(r.start_time, r.end_time, e.start_time, e.end_time));
      }).sort((a, b) => a.slot_id - b.slot_id);
      let resId = null;
      for (const s of candidates) {
        try {
          resId = createReservation(e.user_id, e.vehicle_id, s.slot_id, e.start_time, e.end_time, "WAITLIST");
          break;
        } catch (err) {
          if (!(err instanceof DemoError)) throw err;
          if (err.code === "VEHICLE_ALREADY_BOOKED") { setEntryStatus(e, "CANCELLED"); break; }
        }
      }
      if (resId) {
        setEntryStatus(e, "OFFERED", { offered_reservation_id: resId, offered_at: now() });
        offers++;
      }
    }
    return offers;
  }

  function leaveWaitingList(entryId, userId, isAdmin = false) {
    const e = entry(entryId);
    if (!e || (e.user_id !== Number(userId) && !isAdmin)) fail("NOT_FOUND", "Waiting-list entry not found");
    if (e.status === "WAITING") setEntryStatus(e, "CANCELLED");
    else if (e.status === "OFFERED") cancelReservation(e.offered_reservation_id, userId, isAdmin, "Waiting-list offer declined");
    else fail("INVALID_STATE", `This entry is already ${e.status}`);
  }

  // v_waiting_queue
  function waitingQueue() {
    const positions = new Map();
    DB.waitingList.filter((w) => w.status === "WAITING").sort(queueOrder).forEach((w, i) => positions.set(w.entry_id, i + 1));
    return DB.waitingList.map((w) => {
      const r = w.offered_reservation_id ? reservation(w.offered_reservation_id) : null;
      return { ...w, full_name: user(w.user_id).full_name, registration_no: vehicle(w.vehicle_id).registration_no,
               location_name: location(w.location_id).name, priority_label: PRIORITY_LABEL[w.priority],
               queue_position: positions.get(w.entry_id) || null, offer_expires_at: r ? r.hold_expires_at : null };
    });
  }

  // ================================================================ SCHEDULED JOBS (fn_run_expiry_jobs)
  function runExpiryJobs() {
    const t = now();
    const out = { expired_holds: 0, no_shows: 0, expired_waits: 0, offers_made: 0 };
    DB.reservations.filter((r) => r.status === "HELD" && r.hold_expires_at <= t).forEach((r) => {
      setReservationStatus(r, "EXPIRED", { cancel_reason: "Payment not received before hold expired" }); out.expired_holds++;
    });
    DB.reservations.filter((r) => r.status === "CONFIRMED" && r.start_time.getTime() + DB.policy.no_show_minutes * MIN <= t).forEach((r) => {
      setReservationStatus(r, "NO_SHOW", { cancel_reason: "Did not check in within the allowed window" }); out.no_shows++;
    });
    DB.waitingList.filter((w) => w.status === "WAITING" && w.start_time <= t).forEach((w) => { setEntryStatus(w, "EXPIRED"); out.expired_waits++; });
    out.offers_made = processWaitingList();
    return out;
  }

  // ================================================================ CHARGER PROCEDURES
  function markChargerFaulty(chargerId, issue, adminId = null) {
    const c = charger(chargerId);
    if (!c) fail("CHARGER_NOT_FOUND", "Charger not found");
    if (c.status === "FAULTY") fail("ALREADY_FAULTY", "Charger is already marked faulty");
    DB.maintenance.push({ maintenance_id: nextId("maintenance"), charger_id: c.charger_id,
                          issue_description: (issue || "").trim() || "Charger marked FAULTY",
                          reported_by: adminId, reported_at: now(), resolved_at: null, resolution_note: null });
    const affected = DB.reservations.filter((r) => r.slot_id === c.slot_id && ["HELD", "CONFIRMED"].includes(r.status) && r.end_time > now()).length;
    setChargerStatus(c, "FAULTY");
    return affected;
  }

  function markChargerRepaired(chargerId, note) {
    const c = charger(chargerId);
    if (!c) fail("CHARGER_NOT_FOUND", "Charger not found");
    if (c.status !== "FAULTY") fail("NOT_FAULTY", "Charger is not faulty");
    DB.maintenance.filter((m) => m.charger_id === c.charger_id && !m.resolved_at)
      .forEach((m) => { m.resolved_at = now(); m.resolution_note = (note || "").trim() || "Charger repaired"; });
    setChargerStatus(c, "OPERATIONAL");
    return processWaitingList();
  }

  // ================================================================ ACCOUNTS, VEHICLES, ADMIN DATA
  const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  const PHONE_RE = /^[6-9][0-9]{9}$/;
  const PLATE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/;
  const CONNECTORS = ["TYPE2", "CCS2", "CHADEMO", "BHARAT_AC001"];

  function validateVehicle(v) {
    const plate = String(v.registration_no || "").toUpperCase().replace(/[\s-]/g, "");
    if (!PLATE_RE.test(plate)) fail("INVALID_INPUT", "Registration number must look like TN09AB1234");
    if (!["CAR", "SUV", "BIKE"].includes(v.vehicle_type)) fail("INVALID_INPUT", "Vehicle type must be CAR, SUV or BIKE");
    if (String(v.model_name || "").trim().length < 2) fail("INVALID_INPUT", "Please enter the vehicle model");
    if (v.is_ev && !CONNECTORS.includes(v.connector_type)) fail("INVALID_INPUT", "Please choose the EV's charging connector");
    if (DB.vehicles.some((x) => x.registration_no === plate)) fail("DUPLICATE", "This vehicle registration number is already registered");
    return { registration_no: plate, vehicle_type: v.vehicle_type, model_name: v.model_name.trim(),
             is_ev: !!v.is_ev, connector_type: v.is_ev ? v.connector_type : null };
  }

  function addVehicle(userId, v) {
    const clean = validateVehicle(v);
    const row = { vehicle_id: nextId("vehicles"), user_id: Number(userId), ...clean, created_at: now() };
    DB.vehicles.push(row);
    return row.vehicle_id;
  }

  function deleteVehicle(userId, vehicleId) {
    const v = vehicle(vehicleId);
    if (!v || v.user_id !== Number(userId)) fail("NOT_FOUND", "Vehicle not found");
    if (DB.reservations.some((r) => r.vehicle_id === v.vehicle_id))
      fail("INVALID_REFERENCE", "This vehicle has bookings on record, so it cannot be deleted (ON DELETE RESTRICT).");
    DB.vehicles.splice(DB.vehicles.indexOf(v), 1);
    DB.waitingList = DB.waitingList.filter((w) => w.vehicle_id !== v.vehicle_id);      // ON DELETE CASCADE
  }

  function register({ full_name, email, phone, password, vehicle: v }) {
    email = String(email || "").trim().toLowerCase();
    const errors = [];
    if (String(full_name || "").trim().length < 2) errors.push("Please enter your full name.");
    if (!EMAIL_RE.test(email)) errors.push("Please enter a valid email address.");
    if (!PHONE_RE.test(phone || "")) errors.push("Phone must be a 10-digit Indian mobile number starting with 6–9.");
    if (!password || password.length < 8 || !/\d/.test(password) || !/[A-Za-z]/.test(password))
      errors.push("Password must be at least 8 characters with letters and numbers.");
    if (errors.length) fail("INVALID_INPUT", errors.join(" "));
    if (DB.users.some((u) => u.email === email)) fail("DUPLICATE", "An account with this email already exists");
    if (DB.users.some((u) => u.phone === phone)) fail("DUPLICATE", "An account with this phone number already exists");
    const clean = v && v.registration_no ? validateVehicle(v) : null;               // validate before inserting (one "transaction")
    const u = { user_id: nextId("users"), full_name: full_name.trim(), email, phone, password, role: "USER",
                membership_tier: "STANDARD", has_accessibility_permit: false, created_at: now() };
    DB.users.push(u);
    if (clean) DB.vehicles.push({ vehicle_id: nextId("vehicles"), user_id: u.user_id, ...clean, created_at: now() });
    return u.user_id;
  }

  function login(email, password) {
    const u = DB.users.find((x) => x.email === String(email || "").trim().toLowerCase());
    if (!u || u.password !== password) fail("LOGIN_FAILED", "Invalid email or password.");
    return u;
  }

  function addLocation({ name, address, city, pincode }) {
    [name, address, city] = [name, address, city].map((x) => String(x || "").trim());
    if (!name || !address || !city) fail("INVALID_INPUT", "Name, address and city are required");
    if (!/^[1-9][0-9]{5}$/.test(pincode || "")) fail("INVALID_INPUT", "PIN code must be 6 digits and not start with 0");
    if (DB.locations.some((l) => l.name === name && l.city === city)) fail("DUPLICATE", "A location with this name already exists in this city");
    const l = { location_id: nextId("locations"), name, address, city, pincode, is_active: true };
    DB.locations.push(l);
    return l.location_id;
  }

  function addSlot({ location_id, slot_code, floor_level = 0, slot_type, size_class, charger_type, connector_type, power_kw }) {
    const code = String(slot_code || "").trim().toUpperCase();
    if (!code) fail("INVALID_INPUT", "Slot code is required");
    if (!location(location_id)) fail("INVALID_REFERENCE", "Unknown location");
    if (DB.slots.some((s) => s.location_id === Number(location_id) && s.slot_code === code))
      fail("DUPLICATE", "A slot with this code already exists at this location");
    if (slot_type === "EV") {                         // ck_chargers_type_power
      const kw = Number(power_kw);
      const ok = (charger_type === "AC" && kw > 0 && kw <= 22 && ["TYPE2", "BHARAT_AC001"].includes(connector_type)) ||
                 (charger_type === "DC" && kw >= 15 && kw <= 350 && ["CCS2", "CHADEMO"].includes(connector_type));
      if (!ok) fail("INVALID_INPUT", "Invalid charger: AC ≤ 22 kW with Type 2/Bharat AC-001, DC ≥ 15 kW with CCS2/CHAdeMO (rule ck_chargers_type_power)");
    }
    const s = { slot_id: nextId("slots"), location_id: Number(location_id), slot_code: code, floor_level: Number(floor_level) || 0,
                slot_type, size_class, occupancy_status: "FREE", is_active: true };
    DB.slots.push(s);
    if (slot_type === "EV") DB.chargers.push({ charger_id: nextId("chargers"), slot_id: s.slot_id, charger_type,
                                               connector_type, power_kw: Number(power_kw), status: "OPERATIONAL" });
    return s.slot_id;
  }

  window.SPDB = {
    DB, DemoError, ACTIVE, SIZE, PRIORITY_LABEL, CONNECTORS,
    user, vehicle, location, slot, charger, chargerOfSlot, reservation, entry,
    getRate, peakMultiplier, calculatePrice, searchSlots, createReservation, makePayment, cancelReservation,
    checkIn, checkOut, finalBill, userPriority, joinWaitingList, processWaitingList, leaveWaitingList,
    waitingQueue, runExpiryJobs, markChargerFaulty, markChargerRepaired, setReservationStatus, setChargerStatus,
    addVehicle, deleteVehicle, register, login, addLocation, addSlot, insertEntry, audit, nextId,
  };
})();
