import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./calendar.css"; // scoped styles ONLY

const API = import.meta.env.VITE_API || "http://localhost:8787/api";

/* ==== Sheen split line (your exact coords) ================================= */
const SHEEN_SPLIT = {
  A: { lat: 51.471333, lon: -0.267963 }, // TOP
  B: { lat: 51.457055, lon: -0.267663 }, // BOTTOM
};
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function sideOfSplit(A, B, P) {
  const t = clamp((P.lat - A.lat) / (B.lat - A.lat), 0, 1);
  const lonOnLine = A.lon + (B.lon - A.lon) * t;
  return P.lon < lonOnLine ? "left" : "right"; // west=left, east=right
}

/* Defaults used only if backend/config is empty (non-breaking) */
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
  new Date(iso).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

/* ---------------- UI: NO global header to avoid double logos ---------------- */

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
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={cx("gm panel", loading && "loading")}>
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

      <div style={{ marginTop: 8 }}>
        <div className="gm muted" style={{ marginBottom: 6 }}>Add-ons (optional)</div>
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

      <div className="gm actions">
        <button className="gm btn" onClick={onBack}>Back</button>
        <button className="gm btn primary" onClick={onNext}>See times</button>
      </div>
    </div>
  );
}

/* ---------- Strict Month Grid (only current month’s days) -------- */
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

  const ym = (d) => d.getFullYear() * 12 + d.getMonth();
  const curIndex = ym(monthStart);
  const earliestMonth = earliestKey ? new Date(earliestKey + "T00:00:00") : monthStart;
  const latestMonth = latestKey ? new Date(latestKey + "T00:00:00") : monthStart;
  const minIndex = ym(new Date(earliestMonth.getFullYear(), earliestMonth.getMonth(), 1));
  const maxIndex = ym(new Date(latestMonth.getFullYear(), latestMonth.getMonth(), 1));
  const prevDisabled = curIndex <= minIndex;
  const nextDisabled = curIndex >= maxIndex;

  const cells = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
    const k = keyLocal(d);
    const has = !!slotsByDay[k];
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
  const [selected, setSelected] = useState(state.slot || null);
  const [selected2, setSelected2] = useState(state.membershipSlots || []);
  const [monthCursor, setMonthCursor] = useState(new Date());

  useEffect(() => {
    setLoading(true);
    fetch(API + "/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_key: state.service_key,
        addons: state.addons || [],
        area: state.area || "right",
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        const s = d.slots || [];
        setSlots(s);
        const g = groupByDayLocal(s);
        const keys = Object.keys(g).sort();
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
  }, [state.service_key, state.addons, state.area]);

  const slotsByDay = useMemo(() => groupByDayLocal(slots), [slots]);
  const allKeys = useMemo(() => Object.keys(slotsByDay).sort(), [slotsByDay]);
  const earliestKey = allKeys[0] || null;
  const latestKey = allKeys[allKeys.length - 1] || null;
  const daySlots = selectedDay ? (slotsByDay[selectedDay] || []) : [];

  function sameLocalDay(isoA, isoB) {
    const a = new Date(isoA), b = new Date(isoB);
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function choose(slot) {
    if (isMembership) {
      setSelected2((curr) => {
        const exists = curr.find((s) => s.start_iso === slot.start_iso);
        if (exists) return curr.filter((s) => s.start_iso !== slot.start_iso);
        if (curr.length === 1 && sameLocalDay(curr[0].start_iso, slot.start_iso)) {
          alert("Membership visits must be on two different days."); return curr;
        }
        if (curr.length >= 2) return [curr[1], slot];
        return [...curr, slot];
      });
    } else {
      setSelected(slot);
    }
  }

  const membershipCount = isMembership ? (selected2?.length || 0) : 0;
  const canNext = isMembership ? membershipCount === 2 : !!selected;

  return (
    <div className={cx("gm-booking", loading && "loading")}>
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
          membershipCount={membershipCount}
          isMembership={isMembership}
        />
      </div>

      <div className="gm panel">
        <h3 className="gm h3">
          {selectedDay
            ? new Date(selectedDay).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })
            : "Select a highlighted date"}
        </h3>

        {(!selectedDay || daySlots.length === 0) && (
          <div className="gm note">No times on this day. Pick another highlighted date.</div>
        )}

        {daySlots.length > 0 && (
          <div className="gm timepills">
            {daySlots.map((s) => {
              const sel = isMembership
                ? !!selected2.find((x) => x.start_iso === s.start_iso)
                : selected?.start_iso === s.start_iso;
              return (
                <button
                  key={s.start_iso}
                  className={cx("gm pill", sel && "pill-on")}
                  onClick={() => choose(s)}
                  type="button"
                >
                  {new Date(s.start_iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </button>
              );
            })}
          </div>
        )}

        <div className="gm actions">
          <button className="gm btn" onClick={onBack}>Back</button>
          <button className="gm btn primary" disabled={!canNext}
            onClick={() => {
              if (isMembership) setState((s) => ({ ...s, membershipSlots: selected2 }));
              else setState((s) => ({ ...s, slot: selected }));
              onNext();
            }}
          >
            Continue
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
    ? state.membershipSlots?.map((s) => dstr(s.start_iso)).join(" & ")
    : state.slot && dstr(state.slot.start_iso);

  return (
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
    <div className="gm-booking">
      {step === 0 && <Details  onNext={() => setStep(1)} state={state} setState={setState} />}
      {step === 1 && <Services onNext={() => setStep(2)} onBack={() => setStep(0)} state={state} setState={setState} config={config} />}
      {step === 2 && <Calendar onNext={() => setStep(3)} onBack={() => setStep(1)} state={state} setState={setState} />}
      {step === 3 && <Confirm  onBack={() => setStep(2)} state={state} setState={setState} />}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
