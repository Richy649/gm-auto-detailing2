import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./calendar.css";

/* ===== Config ===== */
const MAX_DAYS_AHEAD = 30;
const MIN_LEAD_MIN = 24 * 60;
const BUFFER_MIN = 30;              // 30-min buffer between jobs
const SLOT_STEP_MIN = 15;           // 15-min grid for neat times

/* ===== Service catalog (fallback if /config is empty) ===== */
const DEFAULT_SERVICES = {
  exterior: { name: "Exterior Detail", duration: 75, price: 60 },
  full: { name: "Full Detail", duration: 120, price: 120 },
  standard_membership: { name: "Standard Membership (2 Exterior visits)", duration: 75, visits: 2, visitService: "exterior", price: 100 },
  premium_membership: { name: "Premium Membership (2 Full visits)", duration: 120, visits: 2, visitService: "full", price: 220 },
};
const DEFAULT_ADDONS = { wax: { name: "Full Body Wax", price: 15 }, polish: { name: "Hand Polish", price: 15 } };

const API = import.meta.env.VITE_API || "http://localhost:8787/api";

/* ===== Utils ===== */
const fmtGBP = (n) => `£${(Math.round(n * 100) / 100).toFixed(2)}`;
const cx = (...a) => a.filter(Boolean).join(" ");
const hasKeys = (o) => o && typeof o === "object" && Object.keys(o).length > 0;

const keyLocal = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const dstr = (iso) =>
  new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const isWeekend = (d) => [0, 6].includes(d.getDay());
const addMinutes = (d, mins) => new Date(d.getTime() + mins * 60000);
const clone = (d) => new Date(d.getTime());

function alignUp(date, minutes = SLOT_STEP_MIN) {
  const d = new Date(date);
  const ms = minutes * 60000;
  const rem = d.getTime() % ms;
  if (rem !== 0) d.setTime(d.getTime() + (ms - rem));
  return d;
}

/* ===== Working window (local time) =====
   Weekdays: 16:00–21:00
   Weekends: 09:00–19:30
   We allow the *last* job of the day to end after the window end. */
function workWindowLocal(day) {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  let start, end;
  if (isWeekend(d)) {
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0, 0);
    end   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 19, 30, 0, 0);
  } else {
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 16, 0, 0, 0);
    end   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 0, 0, 0);
  }
  return { start, end };
}

/* Resolve service duration, mapping memberships to their visit service duration */
function serviceDuration(service_key, services) {
  const svc = services?.[service_key];
  if (!svc) return 0;
  if (service_key.includes("membership") && svc.visitService && services[svc.visitService]) {
    return services[svc.visitService].duration || svc.duration || 0;
  }
  return svc.duration || 0;
}

/* Generate *packed* slots for a day given a duration:
   - 15-min aligned
   - 30-min buffer *between* jobs (not before first)
   - respects 24h lead time
   - last job may run past the day's end (we still allow its start if it begins before end)
   - returns [{start_iso, end_iso}]
*/
function generateDaySlots(day, durationMin, now = new Date()) {
  const { start, end } = workWindowLocal(day);

  // Lead-time gate
  const minStart = addMinutes(now, MIN_LEAD_MIN);
  const firstStart = alignUp(new Date(Math.max(start.getTime(), minStart.getTime())), SLOT_STEP_MIN);

  if (firstStart > end) return [];

  const slots = [];
  let cur = firstStart;

  while (true) {
    // if there's already a slot, we must respect buffer after previous end
    if (slots.length) {
      const prevEnd = new Date(slots[slots.length - 1].end_iso);
      const earliest = addMinutes(prevEnd, BUFFER_MIN);
      if (cur < earliest) cur = alignUp(earliest, SLOT_STEP_MIN);
    }

    // normal case: fits inside window
    const candidateEnd = addMinutes(cur, durationMin);
    if (candidateEnd <= end) {
      slots.push({ start_iso: cur.toISOString(), end_iso: candidateEnd.toISOString() });
      // move to next start by duration+buffer
      cur = alignUp(addMinutes(candidateEnd, BUFFER_MIN), SLOT_STEP_MIN);
      if (cur > end && slots.length) break;
      continue;
    }

    // overrun case: allow LAST job to start before end even if it ends after
    if (cur < end) {
      slots.push({ start_iso: cur.toISOString(), end_iso: candidateEnd.toISOString() });
    }
    break;
  }

  return slots;
}

/* Build a 30-day availability map keyed by 'YYYY-MM-DD' for the chosen duration */
function generateAvailability(daysAhead, durationMin, now = new Date()) {
  const map = {};
  for (let i = 0; i <= daysAhead; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const slots = generateDaySlots(day, durationMin, now);
    if (slots.length) map[keyLocal(day)] = slots;
  }
  return map;
}

/* ===== Sticky logo header ===== */
function Header() {
  return (
    <header className="gm header">
      <img className="gm logo" src="/logo.png" alt="GM Auto Detailing" style={{ height: "200px" }} />
    </header>
  );
}

/* ===== Details (logo big left; order: Name, Address, Email, Phone) ===== */
function Details({ onNext, state, setState }) {
  const [v, setV] = useState(state.customer || { name: "", address: "", email: "", phone: "" });
  useEffect(() => setState((s) => ({ ...s, customer: v })), [v]);

  const ok = v.name.trim().length>1 && v.phone.trim().length>6 && v.address.trim().length>5;

  return (
    <div className="gm page-section">
      <div className="gm details-grid">
        <div className="gm details-left">
          <img className="gm logo-big" src="/logo.png" alt="GM Auto Detailing" style={{ height: "360px" }} />
        </div>

        <div className="gm details-right">
          <p className="gm hero-note">
            Welcome to <b>gmautodetailing.uk</b>. Share your details so we arrive at the right address and can reach you if plans change.
            I treat every booking like it’s my own car—if anything isn’t clear, message me and I’ll make it right.
          </p>

          <h2 className="gm h2" style={{textAlign:'center'}}>Your details</h2>
          <div className="gm row">
            <input className="gm input" placeholder="Full name" value={v.name} onChange={(e)=>setV({...v, name:e.target.value})}/>
            <input className="gm input" placeholder="Address (full address)" value={v.address} onChange={(e)=>setV({...v, address:e.target.value})}/>
          </div>
          <div className="gm row">
            <input className="gm input" placeholder="Email (for confirmation)" value={v.email} onChange={(e)=>setV({...v, email:e.target.value})}/>
            <input className="gm input" placeholder="Phone" value={v.phone} onChange={(e)=>setV({...v, phone:e.target.value})}/>
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

/* ===== Services (Add-on cards with price + Add/Remove; headings centred) ===== */
function Services({ onNext, onBack, state, setState, config }) {
  const svc = hasKeys(config?.services) ? config.services : DEFAULT_SERVICES;
  const addonsCfg = hasKeys(config?.addons) ? config.addons : DEFAULT_ADDONS;

  const firstKey = Object.keys(svc)[0];
  const [service, setService] = useState(state.service_key && svc[state.service_key] ? state.service_key : firstKey);
  const [addons, setAddons] = useState(state.addons || []);

  useEffect(() => setState((s) => ({ ...s, addons })), [addons]);

  // When service changes: reset incompatible selections + date/slots (prevents carry-over)
  useEffect(() => {
    setState((s) => {
      const isMembership = service.includes("membership");
      const next = { ...s, service_key: service };
      next.selectedDay = null;
      next.prefetchedDaySlots = [];
      if (isMembership) next.slot = null; else next.membershipSlots = [];
      return next;
    });
  }, [service, setState]);

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
        <div className="benefit-title" style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          <span>{title}</span><span>{fmtGBP(price)}</span>
        </div>
        <div className="benefit-copy">{desc}</div>
        <div style={{marginTop:10, display:'flex', justifyContent: align === 'left' ? 'flex-start' : 'flex-end'}}>
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
        <h2 className="gm h2" style={{ textAlign:'center' }}>Choose your service</h2>

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

        <div className="gm muted" style={{ marginBottom: 10, fontWeight: 900, textAlign:'center' }}>
          Add-ons (optional)
        </div>

        <div className="gm addon-benefits two-col" style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
          <AddonCard
            k="wax"
            title="Full Body Wax"
            price={addonsCfg.wax?.price ?? 15}
            desc="Deep gloss and slick feel. Adds a protective layer that helps repel grime and water between washes."
            align="left"
          />
          <AddonCard
            k="polish"
            title="Hand Polish"
            price={addonsCfg.polish?.price ?? 15}
            desc="Reduces haze and light oxidation to refresh tired paintwork, restoring clarity and depth to the finish."
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

/* ===== Calendar grid (driven by client-generated availability) ===== */
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
  const monthTitle = monthStart.toLocaleString([], { month: "long", year: "numeric" });
  const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();

  const ym = (d) => d.getFullYear() * 12 + d.getMonth();
  const curIdx = ym(monthStart);
  const minIdx = earliestKey ? ym(new Date(earliestKey + "T00:00:00")) : curIdx;
  const maxIdx = latestKey   ? ym(new Date(latestKey   + "T00:00:00")) : curIdx;
  const prevDisabled = curIdx <= minIdx;
  const nextDisabled = curIdx >= maxIdx;

  const inEarliest = earliestKey && monthStart.getFullYear() === new Date(earliestKey+"T00:00:00").getFullYear() && monthStart.getMonth() === new Date(earliestKey+"T00:00:00").getMonth();
  const inLatest   = latestKey   && monthStart.getFullYear() === new Date(latestKey+"T00:00:00").getFullYear()   && monthStart.getMonth() === new Date(latestKey+"T00:00:00").getMonth();

  const startDay = inEarliest ? new Date(earliestKey+"T00:00:00").getDate() : 1;
  const endDay   = inLatest   ? new Date(latestKey+"T00:00:00").getDate()   : daysInMonth;

  const counterStyle = {
    background: "#fff7ed", border: "1px solid #f59e0b", color: "#b45309", fontWeight: 900,
  };

  const closeBtnStyle = {
    position: "absolute", top: 6, right: 6, width: 22, height: 22,
    borderRadius: 999, background: "#0f172a", color: "#fff", border: "1px solid #e5e7eb",
    fontWeight: 900, lineHeight: "20px", fontSize: 14, display: "inline-flex",
    alignItems: "center", justifyContent: "center", cursor: "pointer",
    boxShadow: "0 1px 2px rgba(0,0,0,.12)"
  };

  const cells = [];
  for (let day = startDay; day <= endDay; day++) {
    const d = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
    const k = keyLocal(d);
    const has = !!slotsByDay[k];
    const selected = selectedDay === k;
    const chosen = bookedDays.includes(k);
    const label = `${day}`;

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
          {label}
        </button>
        {isMembership && chosen && (
          <button
            type="button"
            aria-label="Remove this booked day"
            style={closeBtnStyle}
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
      <div className="gm monthbar" style={{ display:'grid', gridTemplateColumns:'1fr auto', alignItems:'center' }}>
        <div className="gm monthtitle" style={{ justifySelf:'center' }}>{monthTitle}</div>
        <div className="gm monthtools">
          {isMembership && <span className="gm counter" style={counterStyle}>{membershipCount}/2</span>}
          <button className="gm btn ghost" disabled={prevDisabled}
            onClick={() => !prevDisabled && setMonthCursor(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1))}
          >‹</button>
          <button className="gm btn ghost" disabled={nextDisabled}
            onClick={() => !nextDisabled && setMonthCursor(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1))}
          >›</button>
        </div>
      </div>

      <div className="gm small-note">We hope you can find a slot that works. If not, message me and I’ll do my best to sort it out.</div>

      <div className="gm dowrow">
        {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => <div key={d} className="gm dow">{d}</div>)}
      </div>

      <div className="gm monthgrid">{cells}</div>
    </div>
  );
}

/* ===== Calendar container ===== */
function Calendar({ onNext, onBack, state, setState, services }) {
  const isMembership = state.service_key?.includes("membership");
  const durationMin = serviceDuration(state.service_key, services);

  // Build 30-day availability map for chosen duration
  const [slotsByDay, setSlotsByDay] = useState({});
  const [selectedDay, setSelectedDay] = useState(state.selectedDay || null);
  const [monthCursor, setMonthCursor] = useState(new Date());

  useEffect(() => {
    const map = generateAvailability(MAX_DAYS_AHEAD, durationMin, new Date());
    setSlotsByDay(map);
    const keys = Object.keys(map).sort();
    if (keys.length && !selectedDay) {
      setSelectedDay(keys[0]);
      setState((s)=>({ ...s, selectedDay: keys[0] }));
      const first = new Date(keys[0] + "T00:00:00");
      setMonthCursor(new Date(first.getFullYear(), first.getMonth(), 1));
    } else if (selectedDay) {
      const d = new Date(selectedDay + "T00:00:00");
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

  const onPickDay = (k) => {
    if (bookedDays.includes(k)) return;
    setSelectedDay(k);
    setState((s) => ({ ...s, selectedDay: k }));
  };

  const onRemoveDay = (dayKey) => {
    setState((st) => ({
      ...st,
      membershipSlots: (st.membershipSlots || []).filter(s => keyLocal(new Date(s.start_iso)) !== dayKey)
    }));
  };

  return (
    <div className="gm page-section">
      <Header />
      <div className="gm panel">
        <h2 className="gm h2" style={{ marginBottom: 12, textAlign: "center" }}>Pick a date</h2>

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
            You’ve already booked <b>{new Date(selectedDay).toLocaleDateString([], {weekday:"long", month:"short", day:"numeric"})}</b>.
            Please pick a <b>different day</b> for your second visit.
          </div>
        )}

        <div className="gm actions">
          <button className="gm btn" onClick={onBack}>Back</button>
          <button
            className="gm btn primary"
            disabled={!selectedDay || selectedIsBooked}
            onClick={() => {
              // Preload the day’s times (no flicker)
              setState((s)=>({ ...s, selectedDay, prefetchedDaySlots: currentDaySlots }));
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

/* ===== Times (built from client-generated availability; swap-on-same-day; “×” to remove) ===== */
function Times({ onNext, onBack, state, setState, services }) {
  const isMembership = state.service_key?.includes("membership");
  const selectedDay = state.selectedDay;

  const durationMin = serviceDuration(state.service_key, services);
  const [daySlots, setDaySlots] = useState(state.prefetchedDaySlots || []);

  useEffect(() => {
    // Rebuild slots for this day and this duration (instant, no network)
    const d = new Date(selectedDay + "T00:00:00");
    setDaySlots(generateDaySlots(d, durationMin, new Date()));
  }, [selectedDay, durationMin]);

  const selected =
    isMembership
      ? (state.membershipSlots || []).find((s)=> s && keyLocal(new Date(s.start_iso)) === selectedDay)
      : state.slot && keyLocal(new Date(state.slot.start_iso)) === selectedDay
          ? state.slot
          : null;

  function sameLocalDay(isoA, isoB) {
    const a = new Date(isoA), b = new Date(isoB);
    return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  }

  // SWAP-on-same-day, prevent dupes, atomic update to resist fast clicks
  function choose(slot) {
    if (!isMembership) {
      setState((st) => ({ ...st, slot }));
      return;
    }
    setState((st) => {
      const ms = Array.isArray(st.membershipSlots) ? [...st.membershipSlots] : [];
      const dayK = keyLocal(new Date(slot.start_iso));

      // If day already chosen, swap to the newly clicked time
      const idxSameDay = ms.findIndex(x => keyLocal(new Date(x.start_iso)) === dayK);
      if (idxSameDay !== -1) {
        ms[idxSameDay] = slot;
        return { ...st, membershipSlots: ms };
      }

      if (ms.length < 2) return { ...st, membershipSlots: [...ms, slot] };

      // If already 2 different days, replace the most recent (slot #2)
      return { ...st, membershipSlots: [ms[0], slot] };
    });
  }

  function removeSelectedSlot(slot) {
    if (!isMembership) {
      setState((st) => ({ ...st, slot: null }));
    } else {
      setState((st) => ({
        ...st,
        membershipSlots: (st.membershipSlots || []).filter((x) => x.start_iso !== slot.start_iso)
      }));
    }
  }

  const canNext = isMembership ? ((state.membershipSlots||[]).length > 0) : !!selected;

  const closeBtnStyle = {
    position: "absolute", top: 6, right: 6, width: 22, height: 22,
    borderRadius: 999, background: "#0f172a", color: "#fff", border: "1px solid #e5e7eb",
    fontWeight: 900, lineHeight: "20px", fontSize: 14, display: "inline-flex",
    alignItems: "center", justifyContent: "center", cursor: "pointer",
    boxShadow: "0 1px 2px rgba(0,0,0,.12)"
  };

  return (
    <div className="gm page-section">
      <Header />
      <div className="gm panel">
        <h2 className="gm h2" style={{ textAlign: "center", marginBottom: 10 }}>
          {new Date(selectedDay).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
        </h2>

        <div className="gm timegrid">
          {daySlots.map((s)=> {
            const sel = selected?.start_iso === s.start_iso ||
                        (isMembership && (state.membershipSlots||[]).some(x=>x.start_iso===s.start_iso));
            return (
              <div key={s.start_iso} className="gm timebox-wrap" style={{ position: "relative" }}>
                <button className={cx("gm timebox", sel && "timebox-on")} onClick={()=>choose(s)} type="button">
                  {new Date(s.start_iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </button>
                {sel && (
                  <button
                    type="button"
                    aria-label="Remove this booking"
                    style={closeBtnStyle}
                    onClick={(e) => { e.stopPropagation(); removeSelectedSlot(s); }}
                    title="Remove this booking"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="gm actions">
          <button className="gm btn" onClick={onBack}>Back to calendar</button>
          <button
            className="gm btn primary"
            disabled={!canNext}
            onClick={() => {
              if (isMembership && (state.membershipSlots||[]).length === 1) {
                onBack(); // choose second date; first day stays highlighted
              } else {
                onNext();
              }
            }}
          >
            {isMembership && (state.membershipSlots||[]).length === 1 ? "Choose second date" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===== Confirm (unchanged logic) ===== */
function Confirm({ onBack, state, setState }) {
  const isMembership = state.service_key?.includes("membership");
  const total = React.useMemo(() => {
    const map = { exterior: 60, full: 120, standard_membership: 100, premium_membership: 220 };
    const addonsMap = { wax: 15, polish: 15 };
    let t = map[state.service_key] || 0;
    if (!isMembership) t += (state.addons || []).reduce((s, k) => s + (addonsMap[k] || 0), 0);
    return t;
  }, [state.service_key, state.addons, isMembership]);

  async function confirm() {
    const payload = {
      customer: state.customer,
      service_key: state.service_key,
      addons: state.addons || [],
      slot: state.slot,
      membershipSlots: state.membershipSlots,
      area: "any"
    };
    const res = await fetch(API + "/book", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }).then((r) => r.json());
    if (res.ok) { alert("Booking confirmed. Check your email."); setState({}); location.href = "/"; }
    else { alert("Error: " + (res.error || "Unknown")); }
  }

  const when = isMembership
    ? (state.membershipSlots||[]).map((s) => dstr(s.start_iso)).join(" & ")
    : state.slot && dstr(state.slot.start_iso);

  return (
    <div className="gm page-section">
      <Header />
      <div className="gm panel">
        <h2 className="gm h2">Confirm</h2>
        <div className="gm row">
          <div className="gm panel sub">
            <div><b>Name:</b> {state.customer?.name}</div>
            <div><b>Address:</b> {state.customer?.address}</div>
            <div><b>Email:</b> {state.customer?.email}</div>
            <div><b>Phone:</b> {state.customer?.phone}</div>
            <div><b>Service:</b> {state.service_key}</div>
            <div><b>Add-ons:</b> {(state.addons || []).join(", ") || "None"}</div>
            <div><b>When:</b> {when || "—"}</div>
          </div>
          <div className="gm panel sub">
            <div className="gm muted">Total due</div>
            <div className="gm total">{fmtGBP(total)}</div>
          </div>
        </div>

        <div className="gm actions">
          <button className="gm btn" onClick={onBack}>Back</button>
          <button className="gm btn primary" onClick={confirm}>Confirm & Pay</button>
        </div>
      </div>
    </div>
  );
}

/* ===== App (stepper) ===== */
function App() {
  const [state, setState] = useState({});
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState({ services: {}, addons: {} });

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
        {step === 0 && <Details  onNext={() => setStep(1)} state={state} setState={setState} />}
        {step === 1 && (
          <Services
            onNext={() => setStep(2)}
            onBack={() => setStep(0)}
            state={state}
            setState={setState}
            config={config}
          />
        )}
        {step === 2 && (
          <Calendar
            services={services}
            onNext={() => setStep(3)}
            onBack={() => {
              // Leaving Calendar back to Services: reset selections entirely
              setState((s)=>({ ...s, selectedDay: null, slot: null, membershipSlots: [], prefetchedDaySlots: [] }));
              setStep(1);
            }}
            state={state}
            setState={setState}
          />
        )}
        {step === 3 && <Times services={services} onNext={() => setStep(4)} onBack={() => setStep(2)} state={state} setState={setState} />}
        {step === 4 && <Confirm onBack={() => setStep(3)} state={state} setState={setState} />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
