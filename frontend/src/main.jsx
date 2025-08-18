import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./calendar.css";

/* ===================== API base (with safe fallback) ===================== */
const API =
  (typeof window !== "undefined" && window.__API__) ||
  import.meta.env.VITE_API ||
  "https://gm-auto-detailing2.onrender.com/api";

/* ===================== Booking rules ===================== */
const MAX_DAYS_AHEAD = 30;
const MIN_LEAD_MIN = 24 * 60; // 24 hours lead
const BUFFER_MIN = 30; // reserved if needed later

/* ===================== Timezone (fix DST/iPhone) ===================== */
const TZ = "Europe/London";

/* ===================== Catalog / Prices ===================== */
const DEFAULT_SERVICES = {
  exterior: { name: "Exterior Detail", duration: 75, price: 40 },
  full: { name: "Full Detail", duration: 120, price: 60 },
  standard_membership: {
    name: "Standard Membership (2 Exterior visits)",
    duration: 75, visits: 2, visitService: "exterior", price: 70
  },
  premium_membership: {
    name: "Premium Membership (2 Full visits)",
    duration: 120, visits: 2, visitService: "full", price: 100
  },
};
const DEFAULT_ADDONS = {
  wax: { name: "Full Body Wax", price: 15 },
  polish: { name: "Hand Polish", price: 15 },
};

/* ===================== Helpers ===================== */
const fmtGBP = (n) => `£${(Math.round(n * 100) / 100).toFixed(2)}`;
const cx = (...a) => a.filter(Boolean).join(" ");
const hasKeys = (o) => o && typeof o === "object" && Object.keys(o).length > 0;

/* Never use new Date("YYYY-MM-DD") (UTC parse). */
const keyLocal = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const dateFromKeyLocal = (key) => {
  if (!key) return new Date();
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1); // local midnight
};

const dstr = (iso) =>
  new Date(iso).toLocaleString("en-GB", {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ,
  });

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ,
  });

const isWeekend = (d) => [0, 6].includes(d.getDay());
const addMinutes = (d, mins) => new Date(d.getTime() + mins * 60000);
const toISO = (day, hm) => {
  const [H, M] = hm.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), H, M, 0, 0).toISOString();
};

/* Members map to their visit service duration */
function serviceDuration(service_key, services) {
  const svc = services?.[service_key];
  if (!svc) return 0;
  if (service_key?.includes("membership") && svc.visitService && services[svc.visitService]) {
    return services[svc.visitService].duration || svc.duration || 0;
  }
  return svc.duration || 0;
}

/* ===================== Canonical schedules =====================

Weekdays (Mon–Fri): start 16:00
 - 75 min:  16:00, 17:45, 19:45
 - 120 min: 16:00, 18:30

Weekends (Sat–Sun): start 09:00
 - 75 min:  09:00, 10:45, 12:30, 14:15, 16:00, 17:45
 - 120 min: 09:00, 11:30, 14:00, 16:30

(24h lead applies; add-ons don't affect time)
=============================================================== */
function canonicalFamilyForDuration(day, durationMin) {
  if (isWeekend(day)) return durationMin === 120 ? "WE_4x120" : "WE_6x75";
  return durationMin === 120 ? "W_2x120" : "W_3x75";
}
function familiesForDay(day) {
  return isWeekend(day)
    ? [
        { id: "WE_6x75", slots: [{ t: "09:00", d: 75 }, { t: "10:45", d: 75 }, { t: "12:30", d: 75 }, { t: "14:15", d: 75 }, { t: "16:00", d: 75 }, { t: "17:45", d: 75 }] },
        { id: "WE_4x120", slots: [{ t: "09:00", d: 120 }, { t: "11:30", d: 120 }, { t: "14:00", d: 120 }, { t: "16:30", d: 120 }] },
      ]
    : [
        { id: "W_3x75", slots: [{ t: "16:00", d: 75 }, { t: "17:45", d: 75 }, { t: "19:45", d: 75 }] },
        { id: "W_2x120", slots: [{ t: "16:00", d: 120 }, { t: "18:30", d: 120 }] },
      ];
}
function dayStartsCanonical(day, durationMin, now = new Date()) {
  const fams = familiesForDay(day);
  const famId = canonicalFamilyForDuration(day, durationMin);
  const fam = fams.find((f) => f.id === famId);
  if (!fam) return [];
  const inLead = addMinutes(now, MIN_LEAD_MIN);

  const starts = [];
  for (const s of fam.slots) {
    if (s.d !== durationMin) continue;
    const iso = toISO(day, s.t);
    if (new Date(iso) >= inLead) {
      starts.push({ start_iso: iso, end_iso: addMinutes(new Date(iso), durationMin).toISOString(), fam: fam.id, t: s.t, d: s.d });
    }
  }
  return starts.sort((a, b) => new Date(a.start_iso) - new Date(b.start_iso));
}
function buildCalendarAvailability(durationMin, now = new Date()) {
  const map = {};
  for (let i = 0; i <= MAX_DAYS_AHEAD; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const k = keyLocal(day);
    const list = dayStartsCanonical(day, durationMin, now);
    if (list.length) map[k] = list;
  }
  return map;
}

/* ===================== Header ===================== */
function Header({ size = "md" }) {
  return (
    <header className={cx("gm header", size === "lg" && "lg")}>
      <img className={cx("gm logo", size === "lg" && "logo-hero")} src="/logo.png" alt="GM Auto Detailing" />
    </header>
  );
}

/* ===================== Details ===================== */
function Details({ onNext, state, setState }) {
  const [v, setV] = useState(state.customer || { name: "", address: "", email: "", phone: "" });
  useEffect(() => setState((s) => ({ ...s, customer: v })), [v]);
  const ok = v.name.trim().length > 1 && v.phone.trim().length > 6 && v.address.trim().length > 5;

  return (
    <div className="gm page-section">
      <div className="gm details-grid">
        <div className="gm details-left">
          <img className="gm logo-big" src="/logo.png" alt="GM Auto Detailing" />
        </div>
        <div className="gm details-right">
          <p className="gm hero-note" style={{ fontSize: 17, lineHeight: 1.55, letterSpacing: ".2px", fontWeight: 600 }}>
            Welcome to <b>gmautodetailing.uk booking app</b> — we use your details to make sure we arrive on time and at the right location.
          </p>
          <h2 className="gm h2" style={{ textAlign: "center", fontWeight: 900 }}>Your details</h2>
          <div className="gm row">
            <input className="gm input" placeholder="Full name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
            <input className="gm input" placeholder="Address (full address)" value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} />
          </div>
          <div className="gm row">
            <input className="gm input" placeholder="Email (for confirmation)" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
            <input className="gm input" placeholder="Phone" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
          </div>
          <div className="gm actions">
            <button className="gm btn" disabled>Back</button>
            <button className="gm btn primary" onClick={onNext} disabled={!ok}>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===================== Services ===================== */
function Services({ onNext, onBack, state, setState, config }) {
  const svc = hasKeys(config?.services) ? config.services : DEFAULT_SERVICES;
  const addonsCfg = hasKeys(config?.addons) ? config.addons : DEFAULT_ADDONS;
  const firstKey = Object.keys(svc)[0];

  const [service, setService] = useState(state.service_key && svc[state.service_key] ? state.service_key : firstKey);
  const [addons, setAddons] = useState(state.addons || []);
  useEffect(() => setState((s) => ({ ...s, addons })), [addons]);

  useEffect(() => {
    setState((s) => {
      const isMembership = service.includes("membership");
      const next = { ...s, service_key: service };
      next.selectedDay = null;
      next.prefetchedDaySlots = [];
      if (isMembership) next.slot = null; else next.membershipSlots = [];
      return next;
    });
  }, [service]); // eslint-disable-line

  function toggleAddon(k) {
    setAddons((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));
  }

  const AddonCard = ({ k, title, price, desc, align }) => {
    const on = addons.includes(k);
    return (
      <div
        className={cx("gm benefit", align)}
        style={{
          border: on ? "2px solid #86efac" : "1px dashed #e5e7eb",
          background: on ? "#dcfce7" : "#f9fafb",
          borderRadius: 14,
        }}
      >
        <div className="benefit-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{title}</span><span>{fmtGBP(price)}</span>
        </div>
        <div className="benefit-copy">{desc}</div>
        <div style={{ marginTop: 10, display: 'flex', justifyContent: align === 'left' ? 'flex-start' : 'flex-end' }}>
          <button type="button" className="gm btn" onClick={() => toggleAddon(k)} style={{ fontWeight: 900 }}>
            {on ? "Remove" : "Add"}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="gm page-section">
      <Header />
      <div className="gm panel">
        <h2 className="gm h2" style={{ textAlign: "center", fontWeight: 900 }}>Choose your service</h2>

        <div className="gm cards">
          {Object.entries(svc).map(([key, val]) => {
            const isMembership = key.includes("membership") || val.visits >= 2;
            return (
              <button
                type="button"
                key={key}
                className={cx("gm card", service === key && "selected")}
                onClick={() => setService(key)}
              >
                <div className="gm card-title">{val.name}</div>
                {"price" in val && <div className="gm muted">{fmtGBP(val.price)}</div>}
                {!isMembership && "duration" in val && <div className="gm muted">{val.duration} min</div>}
                {isMembership && <div className="gm muted">{val.visits || 2} visits • {val.duration || 0} min each</div>}
              </button>
            );
          })}
        </div>

        <div className="gm section-divider"></div>

        <div className="gm muted" style={{ marginBottom: 10, fontWeight: 900, textAlign: 'center' }}>
          Add-ons (optional)
        </div>

        <div className="gm addon-benefits two-col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <AddonCard
            k="wax"
            title="Full Body Wax"
            price={addonsCfg.wax?.price ?? 15}
            desc="Durable gloss and water beading. Protects the paint between washes."
            align="left"
          />
          <AddonCard
            k="polish"
            title="Hand Polish"
            price={addonsCfg.polish?.price ?? 15}
            desc="Hand-finished clarity. Reduces light haze and brings back shine."
            align="right"
          />
        </div>

        <div className="gm actions bottom-stick">
          <button className="gm btn" onClick={onBack}>Back</button>
          <button className="gm btn primary" onClick={onNext}>See times</button>
        </div>
      </div>
    </div>
  );
}

/* ===================== Month grid (NO weekday row) ===================== */
function MonthGrid({
  slotsByDay,
  selectedDay,
  setSelectedDay,
  monthCursor,
  setMonthCursor,
  earliestKey,
  latestKey,
  bookedDays = [],
  membershipCount,
  isMembership,
  onRemoveDay = () => {}
}) {
  const monthStart = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  const monthTitle = monthStart.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: TZ });
  const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();

  const ym = (d) => d.getFullYear() * 12 + d.getMonth();
  const curIdx = ym(monthStart);
  const minIdx = earliestKey ? ym(dateFromKeyLocal(earliestKey)) : curIdx;
  const maxIdx = latestKey ? ym(dateFromKeyLocal(latestKey)) : curIdx;
  const prevDisabled = curIdx <= minIdx;
  const nextDisabled = curIdx >= maxIdx;

  const inEarliest =
    earliestKey &&
    monthStart.getFullYear() === dateFromKeyLocal(earliestKey).getFullYear() &&
    monthStart.getMonth() === dateFromKeyLocal(earliestKey).getMonth();

  const inLatest =
    latestKey &&
    monthStart.getFullYear() === dateFromKeyLocal(latestKey).getFullYear() &&
    monthStart.getMonth() === dateFromKeyLocal(latestKey).getMonth();

  const startDay = inEarliest ? dateFromKeyLocal(earliestKey).getDate() : 1;
  const endDay = inLatest ? dateFromKeyLocal(latestKey).getDate() : daysInMonth;

  const counterClass = membershipCount >= 2 ? "ok" : "warn";

  const cells = [];
  for (let day = startDay; day <= endDay; day++) {
    const d = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
    const k = keyLocal(d);
    const has = !!slotsByDay[k];
    const selected = selectedDay === k;
    const chosen = bookedDays.includes(k);

    cells.push(
      <div key={k} className="gm daywrap" style={{ position: "relative" }}>
        <button
          className={cx("gm daycell", has && "has", selected && "selected", chosen && "chosen")}
          disabled={!has || chosen}
          onClick={() => setSelectedDay(k)}
          title={d.toDateString()}
          type="button"
          style={{ width: "100%" }}
        >
          {day}
        </button>
        {isMembership && chosen && (
          <button
            type="button"
            aria-label="Remove this booked day"
            className="gm closebtn"
            onClick={(e) => { e.stopPropagation(); onRemoveDay(k); }}
            title="Remove this booking"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Centered month bar with equal-width nav buttons */}
      <div className="gm monthbar">
        <div className="gm monthnav-left">
          <button
            className="gm btn nav"
            disabled={prevDisabled}
            onClick={() => !prevDisabled && setMonthCursor(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1))}
          >
            Previous
          </button>
        </div>

        <div className="gm monthtitle">{monthTitle}</div>

        <div className="gm monthnav-right">
          {isMembership && (
            <span className={cx("gm counter", counterClass)}>
              {membershipCount}/2
            </span>
          )}
          <button
            className="gm btn nav"
            disabled={nextDisabled}
            onClick={() => !nextDisabled && setMonthCursor(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1))}
          >
            Next
          </button>
        </div>
      </div>

      {/* No weekday row here */}
      <div className="gm monthgrid">{cells}</div>
    </div>
  );
}

/* ===================== Calendar ===================== */
function Calendar({ onNext, onBack, state, setState, services }) {
  const isMembership = state.service_key?.includes("membership");
  const durationMin = serviceDuration(state.service_key, services);

  const [slotsByDay, setSlotsByDay] = useState({});
  const [selectedDay, setSelectedDay] = useState(state.selectedDay || null);
  const [monthCursor, setMonthCursor] = useState(new Date());

  useEffect(() => {
    const map = buildCalendarAvailability(durationMin, new Date());
    setSlotsByDay(map);
    const keys = Object.keys(map).sort();
    if (keys.length && !selectedDay) {
      setSelectedDay(keys[0]);
      setState((s) => ({ ...s, selectedDay: keys[0] }));
      const first = dateFromKeyLocal(keys[0]);
      setMonthCursor(new Date(first.getFullYear(), first.getMonth(), 1));
    } else if (selectedDay) {
      const d = dateFromKeyLocal(selectedDay);
      setMonthCursor(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMin]);

  const allKeys = useMemo(() => Object.keys(slotsByDay).sort(), [slotsByDay]);
  const earliestKey = allKeys[0] || null;
  const latestKey = allKeys[allKeys.length - 1] || null;

  const bookedDays = (state.membershipSlots || []).map(s => keyLocal(new Date(s.start_iso)));
  const selectedIsBooked = bookedDays.includes(selectedDay || "");

  const currentDaySlots = selectedDay ? (slotsByDay[selectedDay] || []) : [];
  const onPickDay = (k) => { if (!bookedDays.includes(k)) { setSelectedDay(k); setState((s) => ({ ...s, selectedDay: k })); } };
  const onRemoveDay = (dayKey) => {
    setState((st) => ({
      ...st,
      membershipSlots: (st.membershipSlots || []).filter(s => keyLocal(new Date(s.start_iso)) !== dayKey),
    }));
  };

  return (
    <div className="gm page-section">
      <Header />
      <div className="gm panel">
        <h2 className="gm h2" style={{ marginBottom: 12, textAlign: "center", fontWeight: 900 }}>Pick a date</h2>

        <MonthGrid
          slotsByDay={slotsByDay}
          selectedDay={selectedDay}
          setSelectedDay={onPickDay}
          monthCursor={monthCursor}
          setMonthCursor={setMonthCursor}
          earliestKey={earliestKey}
          latestKey={latestKey}
          bookedDays={bookedDays}
          membershipCount={(state.membershipSlots || []).length}
          isMembership={isMembership}
          onRemoveDay={onRemoveDay}
        />

        {isMembership && selectedIsBooked && (
          <div className="gm note" style={{ marginTop: 10 }}>
            You’ve already booked <b>{dateFromKeyLocal(selectedDay).toLocaleDateString("en-GB", { weekday: "long", month: "short", day: "numeric", timeZone: TZ })}</b>.
            Please pick a <b>different day</b> for your second visit.
          </div>
        )}

        <div className="gm actions">
          <button className="gm btn" onClick={onBack}>Back</button>
          <button
            className="gm btn primary"
            disabled={!selectedDay || selectedIsBooked}
            onClick={() => {
              setState((s) => ({ ...s, selectedDay, prefetchedDaySlots: currentDaySlots }));
              onNext();
            }}
          >
            See times
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===================== Times (logo left, times right) ===================== */
function Times({ onNext, onBack, state, setState, services }) {
  const isMembership = state.service_key?.includes("membership");
  const selectedDay = state.selectedDay;
  const durationMin = serviceDuration(state.service_key, services);

  const day = dateFromKeyLocal(selectedDay); // local date
  const [daySlots, setDaySlots] = useState(state.prefetchedDaySlots || []);
  useEffect(() => {
    setDaySlots(dayStartsCanonical(day, durationMin, new Date()));
  }, [selectedDay, durationMin]);

  const selected =
    isMembership
      ? (state.membershipSlots || []).find((s) => s && keyLocal(new Date(s.start_iso)) === selectedDay)
      : state.slot && keyLocal(new Date(state.slot.start_iso)) === selectedDay
        ? state.slot
        : null;

  function choose(slot) {
    if (!isMembership) {
      setState((st) => ({ ...st, slot }));
      return;
    }
    setState((st) => {
      const ms = Array.isArray(st.membershipSlots) ? [...st.membershipSlots] : [];
      const dayK = keyLocal(new Date(slot.start_iso));
      const idxSameDay = ms.findIndex(x => keyLocal(new Date(x.start_iso)) === dayK);
      if (idxSameDay !== -1) { ms[idxSameDay] = slot; return { ...st, membershipSlots: ms }; }
      if (ms.some(x => keyLocal(new Date(x.start_iso)) === dayK)) return { ...st, membershipSlots: ms };
      if (ms.length < 2) return { ...st, membershipSlots: [...ms, slot] };
      return { ...st, membershipSlots: [ms[0], slot] };
    });
  }

  function removeSelectedSlot(slot) {
    if (!isMembership) setState((st) => ({ ...st, slot: null }));
    else setState((st) => ({ ...st, membershipSlots: (st.membershipSlots || []).filter((x) => x.start_iso !== slot.start_iso) }));
  }

  const canNext = isMembership ? ((state.membershipSlots||[]).length > 0) : !!selected;
  const headerDateObj = selected ? new Date(selected.start_iso) : dateFromKeyLocal(selectedDay);

  return (
    <div className="gm page-section">
      <div className="gm details-grid">
        <div className="gm details-left">
          <img className="gm logo-big" src="/logo.png" alt="GM Auto Detailing" />
        </div>

        <div className="gm details-right">
          <h2 className="gm h2" style={{ textAlign: "center", marginBottom: 16, fontWeight: 900 }}>
            {headerDateObj.toLocaleDateString("en-GB", { weekday: "long", month: "long", day: "numeric", timeZone: TZ })}
          </h2>

          <div className="gm timegrid">
            {daySlots.map((s)=> {
              const sel = selected?.start_iso === s.start_iso ||
                          (isMembership && (state.membershipSlots||[]).some(x=>x.start_iso===s.start_iso));
              return (
                <div key={s.start_iso} className="gm timebox-wrap" style={{ position: "relative" }}>
                  <button className={cx("gm timebox", sel && "timebox-on")} onClick={()=>choose(s)} type="button">
                    {fmtTime(s.start_iso)}
                  </button>
                  {sel && (
                    <button type="button" aria-label="Remove this booking" className="gm closebtn"
                      onClick={(e) => { e.stopPropagation(); removeSelectedSlot(s); }} title="Remove this booking">×</button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="gm actions" style={{ marginTop: 18, display:'flex', justifyContent:'flex-end', gap:8 }}>
            <button className="gm btn" onClick={onBack}>Back to calendar</button>
            <button className="gm btn primary" disabled={!canNext}
              onClick={() => { if (isMembership && (state.membershipSlots||[]).length === 1) onBack(); else onNext(); }}>
              {isMembership && (state.membershipSlots||[]).length === 1 ? "Choose second date" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===================== Confirm (Stripe) ===================== */
function Confirm({ onBack, state, setState }) {
  const [loading, setLoading] = useState(false);

  const total = useMemo(() => {
    const map = { exterior: 40, full: 60, standard_membership: 70, premium_membership: 100 };
    const addonsMap = { wax: 15, polish: 15 };
    let t = map[state.service_key] || 0;
    t += (state.addons || []).reduce((s, k) => s + (addonsMap[k] || 0), 0);
    return t;
  }, [state.service_key, state.addons]);

  async function confirm() {
    if (loading) return;
    setLoading(true);
    try {
      const payload = {
        customer: state.customer,
        service_key: state.service_key,
        addons: state.addons || [],
        slot: state.slot,
        membershipSlots: state.membershipSlots,
      };
      const resp = await fetch(`${API}/pay/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const raw = await resp.text();
      let data; try { data = JSON.parse(raw); } catch { data = { ok: false, error: `Invalid JSON from API: ${raw.slice(0,200)}` }; }
      if (!resp.ok || !data?.ok || !data?.url) throw new Error(data?.error || `HTTP ${resp.status} — ${raw.slice(0,200)}`);
      window.location.href = data.url; // Stripe Checkout
    } catch (err) {
      alert(`Checkout failed:\n${String(err.message || err)}\n\nAPI base: ${API}`);
    } finally { setLoading(false); }
  }

  const when = state.service_key?.includes("membership")
    ? (state.membershipSlots || []).map((s) => dstr(s.start_iso)).join(" & ")
    : state.slot && dstr(state.slot.start_iso);

  return (
    <div className="gm page-section">
      <Header size="lg" />
      <div className="gm panel">
        <h2 className="gm h2" style={{ textAlign:'center', fontWeight: 900, marginBottom: 10 }}>Confirm Booking</h2>

        <div className="gm twocol">
          <div className="gm panel sub">
            <div style={{ marginBottom: 6 }}><b>Date & time:</b> {when || "—"}</div>
            <div style={{ marginBottom: 6 }}><b>Name:</b> {state.customer?.name}</div>
            <div style={{ marginBottom: 6 }}><b>Address:</b> {state.customer?.address}</div>
            <div style={{ marginBottom: 6 }}><b>Email:</b> {state.customer?.email}</div>
            <div style={{ marginBottom: 6 }}><b>Phone:</b> {state.customer?.phone}</div>
            <div style={{ marginBottom: 6 }}><b>Service:</b> {state.service_key}</div>
            <div style={{ marginBottom: 6 }}><b>Add-ons:</b> {(state.addons||[]).join(", ") || "None"}</div>
          </div>
          <div className="gm panel sub" style={{ textAlign:'center' }}>
            <div className="gm muted" style={{ fontSize: 14 }}>Amount due</div>
            <div className="gm total" style={{ fontSize: 36, fontWeight: 900 }}>{fmtGBP(total)}</div>
          </div>
        </div>

        <div className="gm actions" style={{ display:'flex', justifyContent:'space-between' }}>
          <button className="gm btn" onClick={onBack} disabled={loading}>Back</button>
          <button className="gm btn primary" onClick={confirm} disabled={loading}>
            {loading ? "Starting checkout…" : "Confirm & Pay"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===================== Thank You ===================== */
function ThankYou() {
  return (
    <div className="gm page-section">
      <Header />
      <div className="gm panel" style={{ textAlign:'center' }}>
        <h2 className="gm h2" style={{ fontWeight: 900, marginBottom: 10 }}>Thank you for your booking! 🎉</h2>
        <p className="gm muted" style={{ marginBottom: 12 }}>
          A confirmation will be sent to your email. If you don’t see it, please check your spam folder.
        </p>
        <button
          className="gm btn primary"
          onClick={() => { window.history.replaceState({}, "", "/"); window.location.reload(); }}
        >
          Back to start
        </button>
      </div>
    </div>
  );
}

/* ===================== App ===================== */
function App() {
  const [state, setState] = useState({});
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState({ services: {}, addons: {} });

  useEffect(() => {
    const qp = new URLSearchParams(window.location.search);
    if (qp.get("paid") === "1") setStep(5);
    else if (qp.get("cancelled") === "1") alert("Payment cancelled. Your booking wasn’t completed.");
  }, []);

  useEffect(() => {
    fetch(API + "/config")
      .then((r) => r.json())
      .then((d) => {
        const services = hasKeys(d?.services) ? d.services : DEFAULT_SERVICES;
        const addons = hasKeys(d?.addons) ? d.addons : DEFAULT_ADDONS;
        setConfig({ services, addons });
      })
      .catch(() => setConfig({ services: DEFAULT_SERVICES, addons: DEFAULT_ADDONS }));
  }, []);

  const services = hasKeys(config.services) ? config.services : DEFAULT_SERVICES;

  return (
    <div className="gm-site">
      <div className="gm-booking wrap">
        {step === 0 && <Details onNext={() => setStep(1)} state={state} setState={setState} />}
        {step === 1 && <Services onNext={() => setStep(2)} onBack={() => setStep(0)} state={state} setState={setState} config={config} />}
        {step === 2 && (
          <Calendar
            services={services}
            onNext={() => setStep(3)}
            onBack={() => { setState((s) => ({ ...s, selectedDay: null, slot: null, membershipSlots: [], prefetchedDaySlots: [] })); setStep(1); }}
            state={state}
            setState={setState}
          />
        )}
        {step === 3 && <Times services={services} onNext={() => setStep(4)} onBack={() => setStep(2)} state={state} setState={setState} />}
        {step === 4 && <Confirm onBack={() => setStep(3)} state={state} setState={setState} />}
        {step === 5 && <ThankYou />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
