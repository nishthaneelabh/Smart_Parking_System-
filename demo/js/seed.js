// Sample data — the same rows as database/seed.sql, created fresh on every page load.
// Times are relative to "now", exactly like the SQL seed.
(function () {
  const { HOUR, MIN, DAY, istMidnight, startOfHour } = window.SPU;
  const E = window.SPDB;
  const { DB } = E;

  function seed() {
    for (const k of ["users", "vehicles", "locations", "slots", "chargers", "maintenance", "pricingRules",
                     "peakHours", "reservations", "waitingList", "payments", "audit"]) DB[k] = [];
    DB.seq = {};
    const now = new Date();

    // ---- users (IDs 1..14) -------------------------------------------------
    [
      ["Ananya Iyer", "admin@smartpark.in", "9840000001", "ADMIN", "STANDARD", false],
      ["Rohan Sharma", "rohan.sharma@example.in", "9840000002", "USER", "PREMIUM", false],
      ["Meera Pillai", "meera.pillai@example.in", "9840000003", "USER", "STANDARD", false],
      ["Rahul Verma", "rahul.verma@example.in", "9840000004", "USER", "STANDARD", false],
      ["Priya Raghavan", "priya.raghavan@example.in", "9840000005", "USER", "PREMIUM", false],
      ["Arjun Mehta", "arjun.mehta@example.in", "9840000006", "USER", "STANDARD", true],
      ["Kavya Nair", "kavya.nair@example.in", "9840000007", "USER", "STANDARD", false],
      ["Vikram Singh", "vikram.singh@example.in", "9840000008", "USER", "PREMIUM", false],
      ["Sneha Patil", "sneha.patil@example.in", "9840000009", "USER", "STANDARD", false],
      ["Mohammed Irfan", "mohammed.irfan@example.in", "9840000010", "USER", "STANDARD", false],
      ["Divya Krishnan", "divya.krishnan@example.in", "9840000011", "USER", "STANDARD", false],
      ["Karthik Subramanian", "karthik.s@example.in", "9840000012", "USER", "STANDARD", false],
      ["Demo User A", "demo.a@example.in", "9840000013", "USER", "STANDARD", false],
      ["Demo User B", "demo.b@example.in", "9840000014", "USER", "STANDARD", false],
    ].forEach(([full_name, email, phone, role, membership_tier, has_accessibility_permit]) => {
      DB.users.push({ user_id: E.nextId("users"), full_name, email, phone, role, membership_tier, has_accessibility_permit,
                      password: role === "ADMIN" ? "Admin@123" : "Password@123", created_at: now });
    });

    // ---- vehicles ------------------------------------------------------------
    [
      [2, "TN09AB1234", "SUV", "Tata Nexon EV", "CCS2"], [2, "TN10CD5678", "CAR", "Honda City", null],
      [3, "TN07EF2345", "SUV", "MG ZS EV", "CCS2"], [4, "KA03MX4521", "CAR", "Maruti Suzuki Swift", null],
      [5, "KA05PR7788", "SUV", "Hyundai Kona Electric", "CCS2"], [6, "MH12DE1433", "SUV", "Mahindra XUV400", "CCS2"],
      [7, "TN22KN3344", "CAR", "MG Comet EV", "TYPE2"], [8, "MH01VS9090", "SUV", "Toyota Fortuner", null],
      [9, "MH02SP6655", "CAR", "Nissan Leaf", "CHADEMO"], [10, "TN01MI1122", "CAR", "Tata Tigor EV (Bharat AC)", "BHARAT_AC001"],
      [11, "TN09DK4455", "CAR", "Tata Punch EV", "CCS2"], [12, "TN11KS7890", "BIKE", "Royal Enfield Classic 350", null],
      [13, "TN99DA0001", "SUV", "Tata Nexon EV", "CCS2"], [14, "TN99DB0002", "SUV", "MG ZS EV", "CCS2"],
      [3, "TN07GH9012", "CAR", "Hyundai i20", null],
    ].forEach(([user_id, registration_no, vehicle_type, model_name, connector_type]) => {
      DB.vehicles.push({ vehicle_id: E.nextId("vehicles"), user_id, registration_no, vehicle_type, model_name,
                         is_ev: !!connector_type, connector_type, created_at: now });
    });

    // ---- locations -------------------------------------------------------------
    [
      ["Phoenix Marketcity", "142 Velachery Main Road, Velachery", "Chennai", "600042"],
      ["Express Avenue Mall", "49-50 Whites Road, Royapettah", "Chennai", "600014"],
      ["Chennai Central Metro Parking", "Poonamallee High Road, Park Town", "Chennai", "600003"],
      ["VIT Chennai Campus", "Vandalur-Kelambakkam Road, Kelambakkam", "Chennai", "600127"],
      ["Orion Mall", "Dr Rajkumar Road, Rajajinagar", "Bengaluru", "560055"],
      ["Phoenix Palladium", "462 Senapati Bapat Marg, Lower Parel", "Mumbai", "400013"],
    ].forEach(([name, address, city, pincode]) =>
      DB.locations.push({ location_id: E.nextId("locations"), name, address, city, pincode, is_active: true }));

    // ---- slots (40, 16 EV) -------------------------------------------------------
    const S = (loc, code, floor, type, size) =>
      DB.slots.push({ slot_id: E.nextId("slots"), location_id: loc, slot_code: code, floor_level: floor,
                      slot_type: type, size_class: size, occupancy_status: "FREE", is_active: true });
    S(1,"A01",-1,"REGULAR","CAR"); S(1,"A02",-1,"REGULAR","CAR"); S(1,"A03",-1,"REGULAR","CAR");
    S(1,"A04",-1,"REGULAR","BIKE"); S(1,"A05",-1,"REGULAR","SUV");
    S(1,"E01",-1,"EV","SUV"); S(1,"E02",-1,"EV","SUV"); S(1,"E03",-1,"EV","SUV");
    S(2,"B01",-2,"REGULAR","CAR"); S(2,"B02",-2,"REGULAR","CAR"); S(2,"B03",-2,"REGULAR","SUV"); S(2,"B04",-2,"REGULAR","BIKE");
    S(2,"E01",-2,"EV","SUV"); S(2,"E02",-2,"EV","CAR"); S(2,"E03",-2,"EV","CAR");
    S(3,"C01",0,"REGULAR","CAR"); S(3,"C02",0,"REGULAR","CAR"); S(3,"C03",0,"REGULAR","SUV");
    S(3,"E01",0,"EV","SUV"); S(3,"E02",0,"EV","SUV");
    S(4,"V01",0,"REGULAR","CAR"); S(4,"V02",0,"REGULAR","CAR"); S(4,"V03",0,"REGULAR","SUV");
    S(4,"V04",0,"REGULAR","CAR"); S(4,"V05",0,"REGULAR","BIKE");
    S(4,"E01",0,"EV","CAR"); S(4,"E02",0,"EV","CAR"); S(4,"E03",0,"EV","SUV");
    S(5,"O01",-1,"REGULAR","CAR"); S(5,"O02",-1,"REGULAR","CAR"); S(5,"O03",-1,"REGULAR","SUV"); S(5,"O04",-1,"REGULAR","CAR");
    S(5,"E01",-1,"EV","SUV"); S(5,"E02",-1,"EV","SUV"); S(5,"E03",-1,"EV","SUV");
    S(6,"P01",-1,"REGULAR","SUV"); S(6,"P02",-1,"REGULAR","CAR"); S(6,"P03",-1,"REGULAR","CAR");
    S(6,"E01",-1,"EV","SUV"); S(6,"E02",-1,"EV","CAR");
    const slotId = (loc, code) => DB.slots.find((s) => s.location_id === loc && s.slot_code === code).slot_id;
    const vehId = (reg) => DB.vehicles.find((v) => v.registration_no === reg).vehicle_id;

    // ---- chargers ----------------------------------------------------------------
    [
      [1,"E01","AC","TYPE2",7.4], [1,"E02","AC","TYPE2",22], [1,"E03","DC","CCS2",60],
      [2,"E01","DC","CCS2",30], [2,"E02","AC","BHARAT_AC001",3.3], [2,"E03","DC","CHADEMO",50],
      [3,"E01","DC","CCS2",60], [3,"E02","DC","CCS2",30],
      [4,"E01","AC","TYPE2",7.4], [4,"E02","AC","TYPE2",7.4], [4,"E03","DC","CCS2",30],
      [5,"E01","DC","CCS2",60], [5,"E02","AC","TYPE2",22], [5,"E03","DC","CCS2",120],
      [6,"E01","DC","CCS2",50], [6,"E02","AC","TYPE2",7.4],
    ].forEach(([loc, code, charger_type, connector_type, power_kw]) =>
      DB.chargers.push({ charger_id: E.nextId("chargers"), slot_id: slotId(loc, code), charger_type, connector_type,
                         power_kw, status: "OPERATIONAL" }));

    // ---- pricing -----------------------------------------------------------------
    [
      [null,"PARKING",40,"Default parking rate"], [null,"AC",60,"Default AC (slow) charging surcharge"],
      [null,"DC",150,"Default DC fast-charging surcharge"], [2,"PARKING",60,"Express Avenue — premium mall parking"],
      [4,"PARKING",20,"VIT Chennai — subsidised campus parking"], [4,"AC",40,"VIT Chennai — subsidised AC charging"],
      [5,"PARKING",50,"Orion Mall parking"], [6,"PARKING",80,"Lower Parel — high-demand area"],
      [6,"DC",180,"Lower Parel — DC fast charging"],
    ].forEach(([location_id, applies_to, rate_per_hour, description]) =>
      DB.pricingRules.push({ rule_id: E.nextId("pricingRules"), location_id, applies_to, rate_per_hour, is_active: true, description }));
    [
      ["Weekday morning rush", "WEEKDAY", 8, 11, 1.5], ["Evening rush", "ALL", 17, 21, 1.5],
      ["Weekend shopping", "WEEKEND", 11, 17, 1.25],
    ].forEach(([label, day_type, sh, eh, multiplier]) =>
      DB.peakHours.push({ peak_id: E.nextId("peakHours"), label, day_type, start_min: sh * 60, end_min: eh * 60, multiplier }));

    // ---- reservations (same 19 as seed.sql) -------------------------------------
    const H = startOfHour(now), T = istMidnight(1, now);
    const rows = [
      // n, reg, loc, code, anchor, startOffsetHours, durationHours, final, checkoutOffsetMin, method, finePaid, reason
      [1,"TN09AB1234",1,"E03","H",-240,2,"COMPLETED",-10,"UPI",false],
      [2,"TN07EF2345",1,"E02","H",-200,3,"COMPLETED",70,"CARD",true],
      [3,"KA03MX4521",2,"B01","H",-150,2,"COMPLETED",10,"UPI",false],
      [4,"MH01VS9090",1,"A05","H",-100,4,"COMPLETED",150,"NETBANKING",false],
      [5,"KA05PR7788",5,"E01","H",-72,1,"COMPLETED",-5,"WALLET",false],
      [6,"TN22KN3344",4,"E01","H",-48,2,"COMPLETED",20,"UPI",true],
      [7,"TN11KS7890",4,"V05","H",-30,3,"COMPLETED",0,"UPI",false],
      [8,"KA03MX4521",2,"B02","H",-20,2,"CANCELLED",null,"UPI",false,"Change of plans"],
      [9,"MH02SP6655",2,"E03","T",34,2,"CANCELLED",null,"CARD",false,"Cancelled by user"],
      [10,"TN09DK4455",4,"E03","H",-5,2,"EXPIRED",null,null,false,"Payment not received before hold expired"],
      [11,"TN01MI1122",2,"E02","H",-26,2,"NO_SHOW",null,"UPI",false,"Did not check in within the allowed window"],
      [12,"MH12DE1433",6,"E01","H",-1,3,"CHECKED_IN",null,"UPI",false],
      [13,"KA03MX4521",1,"A01","H",-2,4,"CHECKED_IN",null,"CARD",false],
      [14,"TN09AB1234",3,"E01","T",18,2,"CONFIRMED",null,"UPI",false],
      [15,"KA05PR7788",3,"E02","T",18,2,"CONFIRMED",null,"CARD",false],
      [16,"TN07EF2345",1,"E01","T",10,3,"CONFIRMED",null,"UPI",false],
      [17,"MH01VS9090",6,"P01","T",9,8,"CONFIRMED",null,"NETBANKING",false],
      [18,"TN09DK4455",5,"E02","T",14,2,"HELD",null,null,false],
      [19,"TN22KN3344",4,"E01","T",16,2,"HELD",null,null,false],
    ];
    for (const [n, reg, loc, code, anchor, offH, durH, final, coMin, method, finePaid, reason] of rows) {
      const start = new Date((anchor === "H" ? H : T).getTime() + offH * HOUR);
      const end = new Date(start.getTime() + durH * HOUR);
      const v = E.vehicle(vehId(reg));
      const s = E.slot(slotId(loc, code));
      const c = E.chargerOfSlot(s.slot_id);
      const p = E.calculatePrice(loc, s.slot_type, c && c.charger_type, start, end);
      const initial = final === "COMPLETED" ? "CHECKED_IN" : final === "CHECKED_IN" ? "CONFIRMED" : final;
      const created = final === "HELD" ? new Date(now - (n === 18 ? 2 : 15) * MIN)
                    : start < now ? new Date(start - DAY) : new Date(now - 3 * HOUR);
      const r = {
        reservation_id: E.nextId("reservations"), user_id: v.user_id, vehicle_id: v.vehicle_id, slot_id: s.slot_id,
        start_time: start, end_time: end, status: initial, source: "DIRECT",
        hold_expires_at: n === 18 ? new Date(now.getTime() + 8 * MIN) : n === 19 ? new Date(now - 5 * MIN)
                       : final === "EXPIRED" ? new Date(start - DAY + 10 * MIN) : null,
        parking_fee: p.parking_fee, charging_fee: p.charging_fee, overstay_fine: 0, total_amount: p.total,
        check_in_time: final === "COMPLETED" ? new Date(start.getTime() + 5 * MIN) : null, check_out_time: null,
        cancel_reason: reason || null, created_at: created, updated_at: created, _method: method, _finePaid: finePaid,
      };
      DB.reservations.push(r);
      E.audit("reservations", r.reservation_id, "INSERT", null, initial, reason || "");
      // Completing the row fires "trigger A" (overstay fine) exactly as in seed.sql
      if (final === "COMPLETED") E.setReservationStatus(r, "COMPLETED", { check_out_time: new Date(end.getTime() + coMin * MIN) });
      if (final === "CHECKED_IN") E.setReservationStatus(r, "CHECKED_IN", { check_in_time: new Date(start.getTime() + 5 * MIN) });
    }

    // ---- payments ----------------------------------------------------------------
    for (const r of DB.reservations) {
      if (r._method) DB.payments.push({
        payment_id: E.nextId("payments"), reservation_id: r.reservation_id, amount: r.parking_fee + r.charging_fee,
        payment_type: "BOOKING", method: r._method, status: r.status === "CANCELLED" ? "REFUNDED" : "SUCCESS",
        transaction_ref: `SEED-${String(r.reservation_id).padStart(4, "0")}-B`, paid_at: new Date(r.created_at.getTime() + 2 * MIN),
        refunded_at: r.status === "CANCELLED" ? new Date(r.created_at.getTime() + HOUR) : null });
    }
    for (const r of DB.reservations) {
      if (r._finePaid && r.overstay_fine > 0) DB.payments.push({
        payment_id: E.nextId("payments"), reservation_id: r.reservation_id, amount: r.overstay_fine, payment_type: "FINE",
        method: "UPI", status: "SUCCESS", transaction_ref: `SEED-${String(r.reservation_id).padStart(4, "0")}-F`,
        paid_at: new Date(r.check_out_time.getTime() + 5 * MIN), refunded_at: null });
      delete r._method; delete r._finePaid;
    }
    const r18 = E.reservation(18);
    DB.payments.push({ payment_id: E.nextId("payments"), reservation_id: 18, amount: r18.parking_fee + r18.charging_fee,
                       payment_type: "BOOKING", method: "CARD", status: "FAILED", transaction_ref: "SEED-0018-X",
                       paid_at: new Date(now - MIN), refunded_at: null });

    // ---- waiting list: Chennai Central DC chargers full tomorrow 18:00–20:00 -------
    const r14 = E.reservation(14);
    [["TN07EF2345", 50], ["MH12DE1433", 30], ["TN09DK4455", 20]].forEach(([reg, ago]) => {
      const v = E.vehicle(vehId(reg));
      E.insertEntry({ user_id: v.user_id, vehicle_id: v.vehicle_id, location_id: 3, slot_type: "EV", charger_type: "DC",
                      start_time: r14.start_time, end_time: r14.end_time, priority: E.userPriority(v.user_id),
                      requested_at: new Date(now - ago * MIN) });
    });
    E.insertEntry({ user_id: 12, vehicle_id: vehId("TN11KS7890"), location_id: 3, slot_type: "REGULAR",
                    start_time: new Date(H - 50 * HOUR), end_time: new Date(H - 48 * HOUR), priority: 1,
                    status: "EXPIRED", requested_at: new Date(H - 52 * HOUR) });

    // ---- faulty chargers (through the "procedure", so trigger C runs) --------------
    E.markChargerFaulty(E.chargerOfSlot(slotId(4, "E02")).charger_id, "Display blank, not starting session", 1);
    E.markChargerFaulty(E.chargerOfSlot(slotId(5, "E03")).charger_id, "Cooling fan failure — DC output disabled", 1);
    DB.maintenance.push({ maintenance_id: E.nextId("maintenance"), charger_id: E.chargerOfSlot(slotId(1, "E02")).charger_id,
                          issue_description: "Cable connector damaged", reported_by: 1, reported_at: new Date(now - 20 * DAY),
                          resolved_at: new Date(now - 18 * DAY), resolution_note: "Connector cable replaced" });
  }

  window.SPSEED = { seed };
})();
