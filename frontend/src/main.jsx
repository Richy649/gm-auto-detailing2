import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./calendar.css"; // scoped styles only

const API = import.meta.env.VITE_API || "http://localhost:8787/api";
const SHOW_LOGO = (import.meta.env.VITE_SHOW_LOGO || "0") === "1"; // set to 1 if you want our logo visible

/* Sheen split (your coords) */
const SHEEN_SPLIT = {
  A: { lat: 51.471333, lon: -0.267963 }, // TOP
  B: { lat: 51.457055, lon: -0.267663 }, // BOTTOM
};
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function sideOfSplit(A, B, P) {
  const t = clamp((P.lat - A.lat) / (B.lat - A.lat), 0, 1);
  const lonOnLine = A.lon + (B.lon - A.lon) * t;
  return P.lon < lonOnLine ? "left" : "right";
}

/* Allowed days by area — adjusted to avoid adjacent “Sun+Mon” for right side */
const ALLOWED_DOW = {
  right: new Set([1, 3, 5]),     // Mon, Wed, Fri
  left:  new Set([2, 4, 6]),     // Tue, Thu, Sat
  // (We can re-add Sunday later if you want it.)
};

/* safe defaults if backend config is empty */
const DEFAULT_SERVICES = {
  exterior: { name: "Exterior Detail", duration: 75, price: 60 },
  full: { name: "Full Detail", duration: 120, price: 120 },
  standard_membership: { name: "Standard Membership (2 Exterior visits)", duration: 75, visits: 2, visitService: "exterior", price: 100 },
  premium_membership: { name: "Premium Membership (2 Full visits)", duration: 120, visits: 2, visitService: "full", price: 220 },
};
const DEFAULT_ADDONS = {
  wax: { name: "Full Body Wax", price: 15 },
  polish: { name: "Hand Polish", price: 15 },
};
const hasKeys = (o) => o && typeof o === "object" && Object.keys(o).length > 0;

/* utils */
const fmtGBP = (n) => `£${(Math.round(n * 100) / 100).toFixed(2)}`;
const dstr = (iso) =>
  new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const cx = (...a) => a.filter(Boolean).join(" ");
const keyLocal = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
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

/* ---------------- Header (single logo; toggle via VITE_SHOW_LOGO=1) ------- */
function Header() {
  if (!SHOW_LOGO) return null;
  return (
    <header className="gm header">
      <img className="gm logo" src="/logo.png" alt="GM Auto Detailing" />
    </header>
  );
}

/* ---------------- Steps ---------------- */
function Details({ onNext, state, setState }) {
  const [v, setV] = useState(state.customer || { name: "", phone: "", address: "", email: "" });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => setState((s) => ({ ...s, customer: v })), [v]);

  const ok = v.name.trim().length>1 && v.phone.trim().length>6 && v.address.trim().length>5;

  async function next() {
    setErr(""); setLoading(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(v.address)}`;
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      const arr = r.ok ? await r.json() : [];
      if (!arr?.length) throw new Error("not found");
      const P = { lon: parseFloat(arr[0].lon), lat: parseFloat(arr[0].lat) };
      const area = sideOfSplit(SHEEN_SPLIT.A, SHEEN_SPLIT.B, P);
      setState((s) => ({ ...s, area }));
      onNext();
    } catch {
      setErr("Could not locate that address. Please check and try again.");
    } finally { setLoading(false); }
  }

  return (
    <div className="gm panel details-panel">
      {/* space for your “about me” paragraph above the form */}
      <div className="gm about-space"></div>

      <h2 className="gm h2">Your details</h2>
      <div className="gm row">
        <input className="gm input" placeholder="Full name" value={v.name} onChange={(e)=>setV({...v, name:e.target.value})}/>
        <input className="gm input" placeholder="Phone" value={v.phone} onChange={(e)=>setV({...v, phone:e.target.value})}/>
      </div>
      <div className="gm row">
        <input className="gm input" placeholder="Address (full address)" value={v.address} onChange={(e)=>setV({...v, address:e.target.value})}/>
        <input className="gm input" placeholder="Email (for confirmation)" value={v.email||""} onChange={(e)=>setV({...v, email:e.target.value})}/>
      </div>
      {err && <div className="gm note error">{err}</div>}

      <div className="gm actions">
        <button className="gm btn" disabled>Back</button>
        <button className="gm btn primary" onClick={next} disabled={!ok || loading}>
          {loading ? "Checking address…" : "Next"}
        </button>
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

      {/* clear separation */}
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
  );
}

/* ---------- Month Grid (strict; starts at first bookable; no padding) ----- */
function MonthGrid({
  slotsByDay,
  selectedDay,
  setSelectedDay,
  monthCursor,
  setMonthCursor,
  earliestKey,
  latestKey,
  membershipCount,
  isMembership
}) {
  const monthStart = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  const monthTitle = monthStart.toLocaleString([], { month: "long", year: "numeric" });
  const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();

  const earliestDate = earliestKey ? new Date(earliestKey + "T00:00:00") : null;
  const latestDate   = latestKey   ? new Date(latestKey   + "T00:00:00") : null;

  // disable nav outside months that actually contain slots
  const ym = (d) => d.getFullYear() * 12 + d.getMonth();
  const curIdx = ym(monthStart);
  const minIdx = earliestDate ? ym(new Date(earliestDate.getFullYear(), earliestDate.getMonth(), 1)) : curIdx;
  const maxIdx = latestDate   ? ym(new Date(latestDate.getFullYear(),   latestDate.getMonth(),   1)) : curIdx;
  const prevDisabled = curIdx <= minIdx;
  const nextDisabled = curIdx >= maxIdx;

  // Build cells — in the earliest month, start from earliestDate.day (no blank padding).
  const startDay = (earliestDate &&
                    earliestDate.getFullYear() === monthStart.getFullYear() &&
                    earliestDate.getMonth() === monthStart.getMonth())
                  ? earliestDate.getDate()
                  : 1;

  const cells = [];
  for (let day = startDay; day <= daysInMonth; day++) {
    const d = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
    const k = keyLocal(d);
    const has = !!slotsByDay[k];          // clickable only if backend returned slots for that exact day
    const selected = selectedDay === k;
    const label = `${day}${daySuffix(day)}`;

    cells.push(
      <button
        key={k}
        className={cx("gm daycell", has && "has", selected && "selected")}
        disabled={!has}
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

  const [selectedDay, setSelectedDay] = useState(null);
  const [monthCursor, setMonthCursor] = useState(new Date());

  const area = state.area || "right";
  const allowedSet = ALLOWED_DOW[area] || new Set();

  useEffect(() => {
    setLoading(true);
    fetch(API + "/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_key: state.service_key,
        addons: state.addons || [],
        area,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        // filter slots by allowed DOW so we never show disallowed (no Sun/Mon adjacency on right)
        const s = (d.slots || []).filter((sl) => allowedSet.has(new Date(sl.start_iso).getDay()));
        const g = groupByDayLocal(s);
        const keys = Object.keys(g).sort();
        setSlots(s);

        // Jump to the month containing the FIRST bookable day & preselect it
        const firstKey = keys[0] || null;
        if (firstKey) {
          const firstDate = new Date(firstKey + "T00:00:00");
          setMonthCursor(new Date(firstDate.getFullYear(), firstDate.getMonth(), 1));
          setSelectedDay(firstKey);
        } else {
          setSelectedDay(null);
        }
      })
      .finally(() => setLoading(false));
  }, [state.service_key, state.addons, area]);

  const slotsByDay = useMemo(() => groupByDayLocal(slots), [slots]);
  const allKeys = useMemo(() => Object.keys(slotsByDay).sort(), [slotsByDay]);
  const earliestKey = allKeys[0] || null;
  const latestKey = allKeys[allKeys.length - 1] || null;

  return (
    <div className={cx("gm-booking", loading && "loading")}>
      <Header />

      <div className="gm panel">
        <h2 className="gm h2" style={{ marginBottom: 12 }}>Pick a date</h2>
        <MonthGrid
          slotsByDay={slotsByDay}
          selectedDay={selectedDay}
          setSelectedDay={setSelectedDay}
          monthCursor={monthCursor}
          setMonthCursor={setMonthCursor}
          earliestKey={earliestKey}
          latestKey={latestKey}
          membershipCount={(state.membershipSlots || []).length}
          isMembership={isMembership}
        />

        <div className="gm actions">
          <button className="gm btn" onClick={onBack}>Back</button>
          <button
            className="gm btn primary"
            disabled={!selectedDay}
            onClick={() => {
              setState((s)=>({ ...s, selectedDay })); // carry chosen day into next step
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

/* -------- Times page (separate step; uses selectedDay from state) ---------- */
function Times({ onNext, onBack, state, setState }) {
  const isMembership = state.service_key?.includes("membership");
  const selectedDay = state.selectedDay;
  const [daySlots, setDaySlots] = useState([]);
  const area = state.area || "right";
  const allowedSet = ALLOWED_DOW[area] || new Set();

  useEffect(() => {
    if (!selectedDay) return;
    fetch(API + "/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_key: state.service_key,
        addons: state.addons || [],
        area,
      }),
    })
      .then((r)=>r.json())
      .then((d)=>{
        const s = (d.slots || [])
          .filter((sl) => {
            const dt = new Date(sl.start_iso);
            return allowedSet.has(dt.getDay()) && keyLocal(dt) === selectedDay;
          })
          .sort((a,b)=> new Date(a.start_iso) - new Date(b.start_iso));
        setDaySlots(s);
      });
  }, [selectedDay, state.service_key, state.addons, area]);

  const membershipCount = (state.membershipSlots || []).length;

  function choose(slot) {
    if (isMembership) {
      // record as visit #1 or #2 (must be different days; enforced by step separation)
      const current = state.membershipSlots || [];
      const exists = current.find((s) => s.start_iso === slot.start_iso);
      if (exists) {
        setState((st)=>({ ...st, membershipSlots: current.filter((s)=>s.start_iso!==slot.start_iso) }));
      } else {
        const next = current.length >= 2 ? [current[1], slot] : [...current, slot];
        setState((st)=>({ ...st, membershipSlots: next }));
      }
    } else {
      setState((st)=>({ ...st, slot }));
    }
  }

  const selected =
    isMembership
      ? (state.membershipSlots || []).find((s)=> s && keyLocal(new Date(s.start_iso)) === selectedDay)
      : state.slot && keyLocal(new Date(state.slot.start_iso)) === selectedDay
          ? state.slot
          : null;

  const canNext =
    isMembership ? membershipCount > 0 : !!selected;

  return (
    <div className="gm-booking">
      <Header />
      <div className="gm panel">
        <h2 className="gm h2" style={{ marginBottom: 8 }}>
          {new Date(selectedDay).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
        </h2>
        {daySlots.length === 0 && <div className="gm note">No times on this day. Go back and pick another date.</div>}

        <div className="gm timepills">
          {daySlots.map((s)=> {
            const sel = selected?.start_iso === s.start_iso ||
                        (isMembership && (state.membershipSlots||[]).some(x=>x.start_iso===s.start_iso));
            return (
              <button key={s.start_iso} className={cx("gm pill", sel && "pill-on")} onClick={()=>choose(s)} type="button">
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
                // need second day: return to calendar to pick another (must be different day)
                setState((s)=>({ ...s, selectedDay: null })); // clear day so they can choose a different one
                // go back to calendar step
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
      area: state.area || "right",
      service_key: state.service_key,
      addons: state.addons || [],
      slot: state.slot,
      membershipSlots: state.membershipSlots,
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
    <div className="gm-booking">
      <Header />
      <div className="gm panel">
        <h2 className="gm h2">Confirm</h2>
        <div className="gm row">
          <div className="gm panel sub">
            <div><b>Name:</b> {state.customer?.name}</div>
            <div><b>Phone:</b> {state.customer?.phone}</div>
            <div><b>Address:</b> {state.customer?.address}</div>
            <div><b>Area:</b> {(state.area || "right").toUpperCase()}</div>
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
    <div className="gm-booking wrap">
      <Header />

      {step === 0 && <Details  onNext={() => setStep(1)} state={state} setState={setState} />}
      {step === 1 && <Services onNext={() => setStep(2)} onBack={() => setStep(0)} state={state} setState={setState} config={config} />}
      {step === 2 && <Calendar onNext={() => setStep(3)} onBack={() => setStep(1)} state={state} setState={setState} />}
      {step === 3 && <Times    onNext={() => setStep(4)} onBack={() => setStep(2)} state={state} setState={setState} />}
      {step === 4 && <Confirm  onBack={() => setStep(3)} state={state} setState={setState} />}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
