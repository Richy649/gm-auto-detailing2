import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./calendar.css";

const API = import.meta.env.VITE_API || "http://localhost:8787/api";

/* ===== Booking window / rules ===== */
const MAX_DAYS_AHEAD = 30;
const MIN_LEAD_MIN = 24 * 60;
const BUFFER_MIN = 30;

/* ===== Catalog (with your new prices) ===== */
const DEFAULT_SERVICES = {
  exterior: { name: "Exterior Detail", duration: 75, price: 40 },
  full: { name: "Full Detail", duration: 120, price: 60 },
  standard_membership: { name: "Standard Membership (2 Exterior visits)", duration: 75, visits: 2, visitService: "exterior", price: 70 },
  premium_membership: { name: "Premium Membership (2 Full visits)", duration: 120, visits: 2, visitService: "full", price: 100 },
};
const DEFAULT_ADDONS = { wax: { name: "Full Body Wax", price: 15 }, polish: { name: "Hand Polish", price: 15 } };

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
const toISO = (day, hm) => {
  const [H, M] = hm.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), H, M, 0, 0).toISOString();
};

/* ===== Service duration resolver (memberships map to their visit service) ===== */
function serviceDuration(service_key, services) {
  const svc = services?.[service_key];
  if (!svc) return 0;
  if (service_key.includes("membership") && svc.visitService && services[svc.visitService]) {
    return services[svc.visitService].duration || svc.duration || 0;
  }
  return svc.duration || 0;
}

/* =========================================================================
   FAMILY TEMPLATES (capacity-optimised, overrun ≤ 45m, weekday bans kept)
   -------------------------------------------------------------------------
   Weekdays (Mon–Fri) start at 16:00. Overrun allowed until 21:45 max.
   No 19:30 or 21:00 starts. Families:
   - W_3x75:         16:00(75), 17:45(75), 19:45(75)
   - W_2x120:        16:00(120), 18:30(120)
   - W_MIX_A:        16:00(120), 18:30(75), 20:15(75)
   - W_MIX_B:        16:00(75), 17:45(120), 20:15(75)

   Weekends (Sat–Sun) start at 09:00. Overrun allowed until 20:15 max.
   Families (examples that fill the day well and respect +45):
   - WE_6x75:        09:00, 10:45, 12:30, 14:15, 16:00, 17:45 (all 75)
   - WE_4x120:       09:00, 11:30, 14:00, 16:30 (all 120)
   - WE_3x120_2x75:  09:00(120), 11:30(120), 14:00(120), 16:30(75), 18:15(75)
   - WE_1x120_5x75:  09:00(120), 11:30, 13:15, 15:00, 16:45, 18:30 (rest 75)
   - WE_2x120_3x75:  09:00(120), 11:30(120), 14:00(75), 15:45(75), 17:30(75)
   ========================================================================= */
function weekdayFamilies() {
  return [
    { id: "W_3x75", slots: [{t:"16:00",d:75},{t:"17:45",d:75},{t:"19:45",d:75}] },
    { id: "W_2x120", slots: [{t:"16:00",d:120},{t:"18:30",d:120}] },
    { id: "W_MIX_A", slots: [{t:"16:00",d:120},{t:"18:30",d:75},{t:"20:15",d:75}] },
    { id: "W_MIX_B", slots: [{t:"16:00",d:75},{t:"17:45",d:120},{t:"20:15",d:75}] },
  ];
}
function weekendFamilies() {
  return [
    { id: "WE_6x75",        slots: [{t:"09:00",d:75},{t:"10:45",d:75},{t:"12:30",d:75},{t:"14:15",d:75},{t:"16:00",d:75},{t:"17:45",d:75}] },
    { id: "WE_4x120",       slots: [{t:"09:00",d:120},{t:"11:30",d:120},{t:"14:00",d:120},{t:"16:30",d:120}] },
    { id: "WE_3x120_2x75",  slots: [{t:"09:00",d:120},{t:"11:30",d:120},{t:"14:00",d:120},{t:"16:30",d:75},{t:"18:15",d:75}] },
    { id: "WE_1x120_5x75",  slots: [{t:"09:00",d:120},{t:"11:30",d:75},{t:"13:15",d:75},{t:"15:00",d:75},{t:"16:45",d:75},{t:"18:30",d:75}] },
    { id: "WE_2x120_3x75",  slots: [{t:"09:00",d:120},{t:"11:30",d:120},{t:"14:00",d:75},{t:"15:45",d:75},{t:"17:30",d:75}] },
  ];
}
function familiesForDay(day) { return isWeekend(day) ? weekendFamilies() : weekdayFamilies(); }

/* Choose a family for a selected (time,duration), with sensible priorities */
function pickFamily(day, timeHHMM, dur) {
  const fams = familiesForDay(day);
  const fits = fams.filter(f => f.slots.some(s => s.t === timeHHMM && s.d === dur));
  if (!fits.length) return null;
  // Priority: weekend — most jobs; weekday — mixed > 3x75 > 2x120
  if (isWeekend(day)) {
    const score = (f) => f.slots.length; // more jobs first
    return fits.sort((a,b)=>score(b)-score(a))[0];
  } else {
    const order = ["W_MIX_A","W_MIX_B","W_3x75","W_2x120"];
    return fits.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id))[0];
  }
}

/* Build the displayable slots for a day, respecting family lock & 24h lead.
   - If family locked for that day -> only show that family’s starts
   - Else -> show union of starts across families (for the selected duration)
*/
function dayStartsForDuration(day, durationMin, familyLockId, now = new Date()) {
  const fams = familiesForDay(day);
  const inLead = addMinutes(now, MIN_LEAD_MIN);
  const famList = familyLockId ? fams.filter(f=>f.id===familyLockId) : fams;

  const starts = [];
  for (const f of famList) {
    for (const s of f.slots) {
      if (s.d !== durationMin) continue; // show only starts for the chosen service duration
      const iso = toISO(day, s.t);
      if (new Date(iso) >= inLead) starts.push({ start_iso: iso, end_iso: addMinutes(new Date(iso), durationMin).toISOString(), fam: f.id, t: s.t, d: s.d });
    }
  }
  // de-dup by time
  const byT = new Map();
  for (const x of starts) if (!byT.has(x.start_iso)) byT.set(x.start_iso, x);
  return Array.from(byT.values()).sort((a,b)=> new Date(a.start_iso) - new Date(b.start_iso));
}

/* Build calendar availability map (days that have at least one start for the chosen duration) */
function buildCalendarAvailability(durationMin, now = new Date(), dayLocks = {}) {
  const map = {};
  for (let i = 0; i <= MAX_DAYS_AHEAD; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const k = keyLocal(day);
    const list = dayStartsForDuration(day, durationMin, dayLocks[k] || null, now);
    if (list.length) map[k] = list;
  }
  return map;
}

/* ===== Header ===== */
function Header() {
  return (
    <header className="gm header">
      <img className="gm logo" src="/logo.png" alt="GM Auto Detailing" style={{ height: "220px" }} />
    </header>
  );
}

/* ===== Details ===== */
function Details({ onNext, state, setState }) {
  const [v, setV] = useState(state.customer || { name: "", address: "", email: "", phone: "" });
  useEffect(() => setState((s) => ({ ...s, customer: v })), [v]);
  const ok = v.name.trim().length>1 && v.phone.trim().length>6 && v.address.trim().length>5;

  return (
    <div className="gm page-section">
      <div className="gm details-grid">
        <div className="gm details-left">
          <img className="gm logo-big" src="/logo.png" alt="GM Auto Detailing" style={{ height: "380px" }} />
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

/* ===== Services (add-ons are time-free) ===== */
function Services({ onNext, onBack, state, setState, config }) {
  const svc = hasKeys(config?.services) ? config.services : DEFAULT_SERVICES;
  const addonsCfg = hasKeys(config?.addons) ? config.addons : DEFAULT_ADDONS;
  const firstKey = Object.keys(svc)[0];

  const [service, setService] = useState(state.service_key && svc[state.service_key] ? state.service_key : firstKey);
  const [addons, setAddons] = useState(state.addons || []);
  useEffect(() => setState((s) => ({ ...s, addons })), [addons]);

  // Switching service clears incompatible selections and any day family locks
  useEffect(() => {
    setState((s) => {
      const isMembership = service.includes("membership");
      const next = { ...s, service_key: service, dayLocks: {} };
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

/* ===== Month grid ===== */
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

  const counterStyle = { background: "#fff7ed", border: "1px solid #f59e0b", color: "#b45309", fontWeight: 900 };
  const closeBtnStyle = {
    position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 999,
    background: "#0f172a", color: "#fff", border: "1px solid #e5e7eb",
    fontWeight: 900, lineHeight: "20px", fontSize: 14, display: "inline-flex",
    alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 1px 2px rgba(0,0,0,.12)"
  };

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

/* ===== Calendar (uses template availability for the chosen service) ===== */
function Calendar({ onNext, onBack, state, setState, services }) {
  const isMembership = state.service_key?.includes("membership");
  const durationMin = serviceDuration(state.service_key, services);
  const dayLocks = state.dayLocks || {};

  const [slotsByDay, setSlotsByDay] = useState({});
  const [selectedDay, setSelectedDay] = useState(state.selectedDay || null);
  const [monthCursor, setMonthCursor] = useState(new Date());

  useEffect(() => {
    const map = buildCalendarAvailability(durationMin, new Date(), dayLocks);
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
  }, [durationMin, JSON.stringify(dayLocks)]);

  const allKeys = useMemo(() => Object.keys(slotsByDay).sort(), [slotsByDay]);
  const earliestKey = allKeys[0] || null;
  const latestKey = allKeys[allKeys.length - 1] || null;

  const bookedDays = (state.membershipSlots || []).map(s => keyLocal(new Date(s.start_iso)));
  const selectedIsBooked = bookedDays.includes(selectedDay || "");

  const currentDaySlots = selectedDay ? (slotsByDay[selectedDay] || []) : [];
  const onPickDay = (k) => { if (!bookedDays.includes(k)) { setSelectedDay(k); setState((s)=>({ ...s, selectedDay: k })); } };
  const onRemoveDay = (dayKey) => {
    setState((st) => ({
      ...st,
      membershipSlots: (st.membershipSlots || []).filter(s => keyLocal(new Date(s.start_iso)) !== dayKey),
      dayLocks: { ...(st.dayLocks||{}), [dayKey]: undefined }
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

/* ===== Times (family lock + gating; add-ons = zero time) ===== */
function Times({ onNext, onBack, state, setState, services }) {
  const isMembership = state.service_key?.includes("membership");
  const selectedDay = state.selectedDay;
  const durationMin = serviceDuration(state.service_key, services);

  const day = new Date(selectedDay + "T00:00:00");
  const dayLocks = state.dayLocks || {};
  const familyLockId = dayLocks[selectedDay] || null;

  // Build starts for this day/duration respecting any lock (no network)
  const [daySlots, setDaySlots] = useState([]);
  useEffect(() => {
    setDaySlots(dayStartsForDuration(day, durationMin, familyLockId, new Date()));
  }, [selectedDay, durationMin, familyLockId]);

  // Current selection on this day (normal or membership)
  const selected =
    isMembership
      ? (state.membershipSlots || []).find((s)=> s && keyLocal(new Date(s.start_iso)) === selectedDay)
      : state.slot && keyLocal(new Date(state.slot.start_iso)) === selectedDay
          ? state.slot
          : null;

  // Choose a slot -> lock family (if not locked), then apply selection (swap-on-same-day for membership)
  function choose(slot) {
    const t = new Date(slot.start_iso);
    const hh = String(t.getHours()).padStart(2,"0");
    const mm = String(t.getMinutes()).padStart(2,"0");
    const timeHHMM = `${hh}:${mm}`;
    const dur = durationMin; // add-ons add ZERO time by your rule

    setState((st) => {
      // Determine / keep family lock for this day
      const nextLocks = { ...(st.dayLocks || {}) };
      if (!nextLocks[selectedDay]) {
        const fam = pickFamily(day, timeHHMM, dur);
        if (fam) nextLocks[selectedDay] = fam.id;
      }

      if (!isMembership) {
        return { ...st, dayLocks: nextLocks, slot };
      }

      // Membership: swap on same day, prevent dupes
      const ms = Array.isArray(st.membershipSlots) ? [...st.membershipSlots] : [];
      const dayK = keyLocal(new Date(slot.start_iso));
      const idxSameDay = ms.findIndex(x => keyLocal(new Date(x.start_iso)) === dayK);
      if (idxSameDay !== -1) {
        ms[idxSameDay] = slot; // swap to the newly clicked time
        return { ...st, dayLocks: nextLocks, membershipSlots: ms };
      }
      if (ms.length < 2) return { ...st, dayLocks: nextLocks, membershipSlots: [...ms, slot] };
      return { ...st, dayLocks: nextLocks, membershipSlots: [ms[0], slot] };
    });
  }

  // Remove selection (also clears family lock if nothing left that day)
  function removeSelectedSlot(slot) {
    setState((st) => {
      if (!isMembership) {
        const next = { ...st, slot: null };
        // no selection left on this day → free the lock
        const locks = { ...(st.dayLocks || {}) };
        delete locks[selectedDay];
        next.dayLocks = locks;
        return next;
      }
      const ms = (st.membershipSlots || []).filter((x) => x.start_iso !== slot.start_iso);
      const next = { ...st, membershipSlots: ms };
      if (!ms.find(x => keyLocal(new Date(x.start_iso)) === selectedDay)) {
        const locks = { ...(st.dayLocks || {}) };
        delete locks[selectedDay];
        next.dayLocks = locks;
      }
      return next;
    });
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

/* ===== Confirm (updated totals with your prices; add-ons don't change time) ===== */
function Confirm({ onBack, state, setState }) {
  const isMembership = state.service_key?.includes("membership");
  const total = React.useMemo(() => {
    const map = { exterior: 40, full: 60, standard_membership: 70, premium_membership: 100 };
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

  const when = state.service_key?.includes("membership")
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

/* ===== App ===== */
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
              // Leaving Calendar resets selections and locks (per your request)
              setState((s)=>({ ...s, selectedDay: null, slot: null, membershipSlots: [], prefetchedDaySlots: [], dayLocks: {} }));
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
