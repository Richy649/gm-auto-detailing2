import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./calendar.css"; // scoped styles only

const API = import.meta.env.VITE_API || "http://localhost:8787/api";

/* ---- No geolocating for now: we let users book any available day. ---- */

/* Safe defaults (used only if backend/config is empty) */
const DEFAULT_SERVICES = {
  exterior: { name: "Exterior Detail", duration: 75, price: 60 },
  full: { name: "Full Detail", duration: 120, price: 120 },
  standard_membership: { name: "Standard Membership (2 Exterior visits)", duration: 75, visits: 2, visitService: "exterior", price: 100 },
  premium_membership: { name: "Premium Membership (2 Full visits)", duration: 120, visits: 2, visitService: "full", price: 220 },
};
const DEFAULT_ADDONS = { wax: { name: "Full Body Wax", price: 15 }, polish: { name: "Hand Polish", price: 15 } };
const hasKeys = (o) => o && typeof o === "object" && Object.keys(o).length > 0;

/* Utils */
const fmtGBP = (n) => `£${(Math.round(n * 100) / 100).toFixed(2)}`;
const cx = (...a) => a.filter(Boolean).join(" ");
const keyLocal = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const dstr = (iso) =>
  new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function groupByDayLocal(slots) {
  const g = {};
  for (const s of slots || []) {
    const d = new Date(s.start_iso);
    const k = keyLocal(d);
    (g[k] ||= []).push(s);
  }
  for (const k of Object.keys(g)) g[k].sort((a,b)=> new Date(a.start_iso) - new Date(b.start_iso));
  return g;
}
function daySuffix(n){const j=n%10,k=n%100; if(j===1&&k!==11)return"st"; if(j===2&&k!==12)return"nd"; if(j===3&&k!==13)return"rd"; return"th";}

/* Header (single centered logo for all non-Details pages) */
function Header() {
  return (
    <header className="gm header">
      <img className="gm logo" src="/logo.png" alt="GM Auto Detailing" />
    </header>
  );
}

/* ---------------- Steps ---------------- */
function Details({ onNext, state, setState }) {
  const [v, setV] = useState(state.customer || { name: "", phone: "", address: "", email: "" });
  useEffect(() => setState((s) => ({ ...s, customer: v })), [v]);

  const ok = v.name.trim().length>1 && v.phone.trim().length>6 && v.address.trim().length>5;

  return (
    <div className="gm page-section">
      <div className="gm details-grid">
        {/* Left: big logo */}
        <div className="gm details-left">
          <img className="gm logo-big" src="/logo.png" alt="GM Auto Detailing" />
        </div>

        {/* Right: intro + form */}
        <div className="gm details-right">
          <div className="gm hero-note">
            Welcome to <b>gmautodetailing.uk</b>. Share your details so we arrive at the right place and can reach you if
            anything changes. I treat every booking like it’s my own car—if anything isn’t clear, tell me and I’ll
            make it right. You’ll always speak to me directly.
          </div>

          <h2 className="gm h2">Your details</h2>
          <div className="gm row">
            <input className="gm input" placeholder="Full name" value={v.name} onChange={(e)=>setV({...v, name:e.target.value})}/>
            <input className="gm input" placeholder="Phone"     value={v.phone} onChange={(e)=>setV({...v, phone:e.target.value})}/>
          </div>
          <div className="gm row">
            <input className="gm input" placeholder="Address (full address)" value={v.address} onChange={(e)=>setV({...v, address:e.target.value})}/>
            <input className="gm input" placeholder="Email (for confirmation)" value={v.email||""} onChange={(e)=>setV({...v, email:e.target.value})}/>
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

function Services({ onNext, onBack, state, setState, config }) {
  const svc = hasKeys(config?.services) ? config.services : DEFAULT_SERVICES;
  const addonsCfg = hasKeys(config?.addons) ? config.addons : DEFAULT_ADDONS;

  const firstKey = Object.keys(svc)[0];
  const [service, setService] = useState(state.service_key && svc[state.service_key] ? state.service_key : firstKey);
  const [addons, setAddons] = useState(state.addons || []);
  useEffect(() => setState((s) => ({ ...s, service_key: service, addons })), [service, addons]);

  return (
    <div className="gm page-section">
      <Header />
      <div className="gm panel">
        <h2 className="gm h2">Choose your service</h2>

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

        <div>
          <div className="gm muted" style={{ marginBottom: 6, fontWeight: 800 }}>Add-ons (optional)</div>
          <div className="gm addon-row">
            {Object.entries(addonsCfg).map(([k, v]) => {
              const on = addons.includes(k);
              return (
                <button
                  key={k}
                  className={cx("gm chip", on && "chip-on")}
                  onClick={() => setAddons((a) => (on ? a.filter((x) => x !== k) : [...a, k]))}
                >
                  {v.name} · {fmtGBP(v.price)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="gm actions bottom-stick">
          <button className="gm btn" onClick={onBack}>Back</button>
          <button className="gm btn primary" onClick={onNext}>See times</button>
        </div>
      </div>
    </div>
  );
}

/* Merge left+right availability so customers can book any day */
async function fetchAllSlots(service_key, addons) {
  const body = (area) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service_key, addons: addons || [], area })
  });
  const [left, right] = await Promise.all([
    fetch(API + "/availability", body("left")).then(r=>r.json()).catch(()=>({slots:[]})),
    fetch(API + "/availability", body("right")).then(r=>r.json()).catch(()=>({slots:[]})),
  ]);
  const map = new Map();
  for (const s of (left.slots||[]))  map.set(s.start_iso, s);
  for (const s of (right.slots||[])) map.set(s.start_iso, s);
  return Array.from(map.values()).sort((a,b)=> new Date(a.start_iso) - new Date(b.start_iso));
}

/* Strict Month Grid: starts at FIRST bookable day, ends at LAST bookable day */
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
  isMembership
}) {
  const monthStart = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  const monthTitle = monthStart.toLocaleString([], { month: "long", year: "numeric" });
  const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();

  const earliestDate = earliestKey ? new Date(earliestKey + "T00:00:00") : null;
  const latestDate   = latestKey   ? new Date(latestKey   + "T00:00:00") : null;

  // month navigation limits (only months that contain slots)
  const ym = (d) => d.getFullYear() * 12 + d.getMonth();
  const curIdx = ym(monthStart);
  const minIdx = earliestDate ? ym(new Date(earliestDate.getFullYear(), earliestDate.getMonth(), 1)) : curIdx;
  const maxIdx = latestDate   ? ym(new Date(latestDate.getFullYear(),   latestDate.getMonth(),   1)) : curIdx;
  const prevDisabled = curIdx <= minIdx;
  const nextDisabled = curIdx >= maxIdx;

  // clip first and last months to the actual window
  const inEarliest = earliestDate &&
    monthStart.getFullYear() === earliestDate.getFullYear() &&
    monthStart.getMonth()  === earliestDate.getMonth();
  const inLatest = latestDate &&
    monthStart.getFullYear() === latestDate.getFullYear() &&
    monthStart.getMonth()  === latestDate.getMonth();

  const startDay = inEarliest ? earliestDate.getDate() : 1;
  const endDay   = inLatest   ? latestDate.getDate()   : daysInMonth;

  const cells = [];
  for (let day = startDay; day <= endDay; day++) {
    const d = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
    const k = keyLocal(d);
    const has = !!slotsByDay[k];                   // clickable only if backend returned slots for that exact day
    const selected = selectedDay === k;
    const chosen = bookedDays.includes(k);         // already booked membership day (keep highlighted)
    const label = `${day}${daySuffix(day)}`;

    cells.push(
      <button
        key={k}
        className={cx("gm daycell", has && "has", selected && "selected", chosen && "chosen")}
        disabled={!has || chosen}
        onClick={() => setSelectedDay(k)}
        title={d.toDateString()}
        type="button"
      >
        {label}
      </button>
    );
  }

  return (
    <div>
      <div className="gm monthbar">
        <div className="gm monthtitle">{monthTitle}</div>
        <div className="gm monthtools">
          {isMembership && <span className="gm counter">{membershipCount}/2</span>}
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

function Calendar({ onNext, onBack, state, setState }) {
  const isMembership = state.service_key?.includes("membership");
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);

  // Keep previously selected day if returning from Times (so highlight stays)
  const [selectedDay, setSelectedDay] = useState(state.selectedDay || null);
  const [monthCursor, setMonthCursor] = useState(new Date());

  useEffect(() => {
    setLoading(true);
    fetchAllSlots(state.service_key, state.addons)
      .then((s) => {
        setSlots(s);
        const g = groupByDayLocal(s);
        const keys = Object.keys(g).sort();
        if (!selectedDay) {
          const firstKey = keys[0] || null;
          if (firstKey) {
            const firstDate = new Date(firstKey + "T00:00:00");
            setMonthCursor(new Date(firstDate.getFullYear(), firstDate.getMonth(), 1));
            setSelectedDay(firstKey);
          } else {
            setSelectedDay(null);
          }
        } else {
          const d = new Date(selectedDay + "T00:00:00");
          setMonthCursor(new Date(d.getFullYear(), d.getMonth(), 1));
        }
      })
      .finally(() => setLoading(false));
  }, [state.service_key, state.addons]); // eslint-disable-line

  const slotsByDay = useMemo(() => groupByDayLocal(slots), [slots]);
  const allKeys = useMemo(() => Object.keys(slotsByDay).sort(), [slotsByDay]);
  const earliestKey = allKeys[0] || null;
  const latestKey = allKeys[allKeys.length - 1] || null;

  const bookedDays = (state.membershipSlots || []).map(s => keyLocal(new Date(s.start_iso)));
  const selectedIsBooked = bookedDays.includes(selectedDay || "");

  return (
    <div className={cx("gm page-section", loading && "loading")}>
      <Header />

      <div className="gm panel">
        <h2 className="gm h2" style={{ marginBottom: 12, textAlign: "center" }}>Pick a date</h2>

        <MonthGrid
          slotsByDay={slotsByDay}
          selectedDay={selectedDay}
          setSelectedDay={(k)=>{ setSelectedDay(k); setState(s=>({...s, selectedDay:k})); }}
          monthCursor={monthCursor}
          setMonthCursor={setMonthCursor}
          earliestKey={earliestKey}
          latestKey={latestKey}
          bookedDays={bookedDays}
          membershipCount={(state.membershipSlots || []).length}
          isMembership={isMembership}
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
            onClick={() => { setState((s)=>({ ...s, selectedDay })); onNext(); }}
          >
            See times
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------- Times page (big boxes, date centered) ---------- */
function Times({ onNext, onBack, state, setState }) {
  const isMembership = state.service_key?.includes("membership");
  const selectedDay = state.selectedDay;
  const [daySlots, setDaySlots] = useState([]);

  useEffect(() => {
    if (!selectedDay) return;
    fetchAllSlots(state.service_key, state.addons)
      .then((s)=>{
        const filtered = s.filter((sl)=> keyLocal(new Date(sl.start_iso)) === selectedDay);
        setDaySlots(filtered);
      });
  }, [selectedDay, state.service_key, state.addons]);

  // current selection on this day
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

  function choose(slot) {
    if (isMembership) {
      const current = state.membershipSlots || [];
      // Do not allow both visits on the same calendar day
      if (current.length === 1 && sameLocalDay(current[0].start_iso, slot.start_iso)) {
        alert("Membership visits must be on two different days.");
        return;
      }
      const exists = current.find((s) => s.start_iso === slot.start_iso);
      if (exists) setState((st)=>({ ...st, membershipSlots: current.filter((s)=>s.start_iso!==slot.start_iso) }));
      else setState((st)=>({ ...st, membershipSlots: current.length >= 2 ? [current[1], slot] : [...current, slot] }));
    } else {
      setState((st)=>({ ...st, slot }));
    }
  }

  const canNext = isMembership ? ((state.membershipSlots||[]).length > 0) : !!selected;

  return (
    <div className="gm page-section">
      <Header />
      <div className="gm panel">
        <h2 className="gm h2" style={{ textAlign: "center", marginBottom: 10 }}>
          {new Date(selectedDay).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
        </h2>

        {daySlots.length === 0 && <div className="gm note">No times on this day. Go back and pick another date.</div>}

        <div className="gm timegrid">
          {daySlots.map((s)=> {
            const sel = selected?.start_iso === s.start_iso ||
                        (isMembership && (state.membershipSlots||[]).some(x=>x.start_iso===s.start_iso));
            return (
              <button key={s.start_iso} className={cx("gm timebox", sel && "timebox-on")} onClick={()=>choose(s)} type="button">
                {new Date(s.start_iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </button>
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
                // Go back to calendar for visit #2 — keep the first day highlighted
                onBack();
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
            <div><b>Phone:</b> {state.customer?.phone}</div>
            <div><b>Address:</b> {state.customer?.address}</div>
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

/* ---------------- APP ---------------- */
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

  return (
    <div className="gm-site">
      <div className="gm-booking wrap">
        {/* No global header on Details — it has its own left-logo layout */}
        {step === 0 && <Details  onNext={() => setStep(1)} state={state} setState={setState} />}

        {step === 1 && <Services onNext={() => setStep(2)} onBack={() => setStep(0)} state={state} setState={setState} config={config} />}
        {step === 2 && <Calendar onNext={() => setStep(3)} onBack={() => setStep(1)} state={state} setState={setState} />}
        {step === 3 && <Times    onNext={() => setStep(4)} onBack={() => setStep(2)} state={state} setState={setState} />}
        {step === 4 && <Confirm  onBack={() => setStep(3)} state={state} setState={setState} />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
