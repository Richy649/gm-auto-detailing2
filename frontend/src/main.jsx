import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

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

/* ---- defaults (used if backend returns empty) ---- */
const DEFAULT_SERVICES = {
  exterior: { name: "Exterior Detail", duration: 60, price: 60 },
  full: { name: "Full Detail", duration: 120, price: 120 },
  standard_membership: { name: "Standard Membership", includes: ["exterior","exterior"], price: 100 },
  premium_membership: { name: "Premium Membership", includes: ["full","full"], price: 220 },
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
const dkey = (iso) => new Date(iso).toISOString().slice(0, 10);
const cx = (...a) => a.filter(Boolean).join(" ");
function groupByDay(slots) {
  const g = {};
  for (const s of slots || []) {
    const k = dkey(s.start_iso);
    (g[k] ||= []).push(s);
  }
  return g;
}

/* Geocode via Nominatim (no key; light usage) */
async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
    address
  )}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("geocode failed");
  const arr = await r.json();
  if (!arr?.length) throw new Error("address not found");
  return { lon: parseFloat(arr[0].lon), lat: parseFloat(arr[0].lat) };
}

/* ---------------- PAGES ---------------- */
function Details({ onNext, state, setState }) {
  const [v, setV] = useState(
    state.customer || { name: "", phone: "", address: "", email: "" }
  );
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => setState((s) => ({ ...s, customer: v })), [v]);

  const ok =
    v.name.trim().length > 1 &&
    v.phone.trim().length > 6 &&
    v.address.trim().length > 5;

  async function next() {
    setErr("");
    setLoading(true);
    try {
      const p = await geocodeAddress(v.address);
      const area = sideOfSplit(SHEEN_SPLIT.A, SHEEN_SPLIT.B, p); // decide LEFT/RIGHT here
      setState((s) => ({ ...s, area }));
      onNext();
    } catch (e) {
      setErr("Could not locate that address. Please check and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={cx("panel", loading && "loading")}>
      <h2 style={{ marginTop: 0 }}>Your details</h2>
      <div className="row">
        <input placeholder="Full name" value={v.name} onChange={(e)=>setV({...v, name:e.target.value})}/>
        <input placeholder="Phone" value={v.phone} onChange={(e)=>setV({...v, phone:e.target.value})}/>
      </div>
      <div className="row">
        <input placeholder="Address (full address — we’ll pick your Sheen side automatically)" value={v.address} onChange={(e)=>setV({...v, address:e.target.value})}/>
        <input placeholder="Email (for confirmation)" value={v.email||""} onChange={(e)=>setV({...v, email:e.target.value})}/>
      </div>
      {err && <div className="muted" style={{ color: "#b91c1c" }}>{err}</div>}
      <div className="right" style={{ marginTop: 8 }}>
        <button className="btn" disabled>Back</button>
        <button className="btn primary" onClick={next} disabled={!ok || loading}>
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
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Service</h2>
      <div className="cards" style={{ marginBottom: 10 }}>
        {Object.entries(svc).map(([key, val]) => (
          <div
            key={key}
            className={cx("card", service === key && "selected")}
            onClick={() => setService(key)}
            role="button"
            tabIndex={0}
          >
            <div style={{ fontWeight: 700 }}>{val.name}</div>
            {"price" in val && <div className="muted">{fmtGBP(val.price)}</div>}
            {"duration" in val && <div className="muted">{val.duration} min</div>}
            {"includes" in val && <div className="muted">Includes: {val.includes.join(" + ")}</div>}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 6 }}>
        <div className="muted" style={{ marginBottom: 6 }}>Add-ons (optional)</div>
        <div className="row">
          {Object.entries(addonsCfg).map(([k, v]) => {
            const on = addons.includes(k);
            return (
              <button
                key={k}
                className={cx("btn", on && "primary")}
                onClick={() =>
                  setAddons((a) => (on ? a.filter((x) => x !== k) : [...a, k]))
                }
              >
                {v.name} {fmtGBP(v.price)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="right" style={{ marginTop: 10 }}>
        <button className="btn" onClick={onBack}>Back</button>
        <button className="btn primary" onClick={onNext}>See times</button>
      </div>
    </div>
  );
}

/* ---------- Live month calendar: pick day -> show times for that day ---------- */
function MonthGrid({ slotsByDay, selectedDay, setSelectedDay, monthCursor, setMonthCursor }) {
  const firstOfMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  const start = new Date(firstOfMonth);
  // Start week on Monday
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const isCurrentMonth = d.getMonth() === monthCursor.getMonth();
    const has = !!slotsByDay[key];
    const selected = selectedDay === key;
    cells.push(
      <div
        key={key}
        className={
          "daycell " +
          (has ? "has " : "") +
          (!isCurrentMonth ? "disabled " : "") +
          (selected ? "selected " : "")
        }
        onClick={() => isCurrentMonth && has && setSelectedDay(key)}
      >
        {d.getDate()}
      </div>
    );
  }
  const monthName = monthCursor.toLocaleString([], { month: "long", year: "numeric" });
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="monthbar">
        <div style={{ fontWeight: 700 }}>{monthName}</div>
        <div className="nav">
          <button
            className="btn"
            onClick={() =>
              setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1))
            }
          >
            ‹
          </button>
          <button
            className="btn"
            onClick={() =>
              setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1))
            }
          >
            ›
          </button>
        </div>
      </div>
      <div className="monthgrid">
        {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => <div key={d} className="dow">{d}</div>)}
        {cells}
      </div>
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
        area: state.area || "right", // LEFT/RIGHT computed on Details → controls days returned
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        const s = d.slots || [];
        setSlots(s);
        const g = groupByDay(s);
        const firstKey = Object.keys(g).sort()[0] || null;
        setSelectedDay(firstKey);
      })
      .finally(() => setLoading(false));
  }, [state.service_key, state.addons, state.area]);

  const slotsByDay = useMemo(() => groupByDay(slots), [slots]);
  const daySlots = selectedDay ? (slotsByDay[selectedDay] || []) : [];

  function choose(slot) {
    if (isMembership) {
      setSelected2((curr) => {
        const exists = curr.find((s) => s.start_iso === slot.start_iso);
        if (exists) return curr.filter((s) => s.start_iso !== slot.start_iso);
        if (curr.length >= 2) return [curr[1], slot];
        return [...curr, slot];
      });
    } else {
      setSelected(slot);
    }
  }

  const canNext = isMembership ? selected2.length === 2 : !!selected;

  return (
    <div className={cx(loading && "loading")}>
      <MonthGrid
        slotsByDay={slotsByDay}
        selectedDay={selectedDay}
        setSelectedDay={setSelectedDay}
        monthCursor={monthCursor}
        setMonthCursor={setMonthCursor}
      />

      <div className="panel daylist">
        <h3 style={{ marginTop: 0 }}>
          {selectedDay
            ? new Date(selectedDay).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })
            : "Select a highlighted day"}
        </h3>

        {(!selectedDay || daySlots.length === 0) && (
          <div className="muted">No times on this day. Pick another highlighted day.</div>
        )}

        {daySlots.length > 0 && (
          <div>
            {daySlots.map((s) => {
              const sel = isMembership
                ? !!selected2.find((x) => x.start_iso === s.start_iso)
                : selected?.start_iso === s.start_iso;
              return (
                <span
                  key={s.start_iso}
                  className={"slot " + (sel ? "sel" : "")}
                  onClick={() => choose(s)}
                >
                  {new Date(s.start_iso).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              );
            })}
          </div>
        )}

        <div className="stickybar" style={{ marginTop: 12 }}>
          <div className="muted">
            {isMembership
              ? `${selected2.length}/2 times selected`
              : selected
              ? dstr(selected.start_iso)
              : "Select a time"}
          </div>
          <div className="right">
            <button className="btn" onClick={onBack}>Back</button>
            <button
              className="btn primary"
              disabled={!canNext}
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
    </div>
  );
}

function Confirm({ onBack, state, setState }) {
  const isMembership = state.service_key?.includes("membership");
  const total = useMemo(() => {
    const map = { exterior: 60, full: 120, standard_membership: 100, premium_membership: 220 };
    const addonsMap = { wax: 15, polish: 15 };
    let t = map[state.service_key] || 0;
    if (!isMembership) t += (state.addons || []).reduce((s, k) => s + (addonsMap[k] || 0), 0);
    return t;
  }, [state.service_key, state.addons, isMembership]);

  async function confirm() {
    const payload = {
      customer: state.customer,
      area: state.area || "right", // already decided on Details
      service_key: state.service_key,
      addons: state.addons || [],
      slot: state.slot,
      membershipSlots: state.membershipSlots,
    };
    const res = await fetch(API + "/book", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }).then((r) => r.json());
    if (res.ok) {
      alert(`Booking confirmed (${(state.area || "right").toUpperCase()}). Check your email for confirmation.`);
      setState({}); location.href = "/";
    } else {
      alert("Error: " + (res.error || "Unknown"));
    }
  }

  const when = isMembership
    ? state.membershipSlots?.map((s) => dstr(s.start_iso)).join(" & ")
    : state.slot && dstr(state.slot.start_iso);

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Confirm</h2>
      <div className="row">
        <div className="panel" style={{ flex: "1 1 320px" }}>
          <div><b>Name:</b> {state.customer?.name}</div>
          <div><b>Phone:</b> {state.customer?.phone}</div>
          <div><b>Address:</b> {state.customer?.address}</div>
          <div><b>Area:</b> {(state.area || "right").toUpperCase()}</div>
          <div><b>Service:</b> {state.service_key}</div>
          <div><b>Add-ons:</b> {(state.addons || []).join(", ") || "None"}</div>
          <div><b>When:</b> {when || "—"}</div>
        </div>
        <div className="panel" style={{ flex: "1 1 320px" }}>
          <div className="muted">Total due</div>
          <div style={{ fontSize: 28, fontWeight: 800 }}>{fmtGBP(total)}</div>
        </div>
      </div>

      <div className="stickybar">
        <div className="muted">You’ll be charged in full upfront.</div>
        <div className="right">
          <button className="btn" onClick={onBack}>Back</button>
          <button className="btn primary" onClick={confirm}>Confirm & Pay</button>
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
    <>
      {step === 0 && <Details  onNext={() => setStep(1)} state={state} setState={setState} />}
      {step === 1 && <Services onNext={() => setStep(2)} onBack={() => setStep(0)} state={state} setState={setState} config={config} />}
      {step === 2 && <Calendar onNext={() => setStep(3)} onBack={() => setStep(1)} state={state} setState={setState} />}
      {step === 3 && <Confirm  onBack={() => setStep(2)} state={state} setState={setState} />}
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
