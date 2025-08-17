import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

const API = import.meta.env.VITE_API || "http://localhost:8787/api";

/* ---------- small helpers ---------- */
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
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* ---------- area detection (geolocation + manual override) ---------- */
function useArea(address) {
  const [area, setArea] = useState("right");
  const [status, setStatus] = useState("idle"); // idle | asking | ok | denied | error

  // heuristic from address text
  useEffect(() => {
    const s = (address || "").toLowerCase();
    if (s.includes("west")) setArea("left");
    else if (s.includes("east")) setArea("right");
  }, [address]);

  // geolocate once
  useEffect(() => {
    if (!navigator.geolocation) return;
    setStatus("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Rough split around Sheen Ln (~ -0.267). West (left) has longitude < -0.267
        const { longitude } = pos.coords;
        const isLeft = longitude < -0.267;
        setArea(isLeft ? "left" : "right");
        setStatus("ok");
      },
      () => setStatus("denied"),
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 }
    );
  }, []);

  return { area, setArea, status };
}

/* ---------- header + stepper ---------- */
function Header() {
  return (
    <header>
      <div className="brand">
        <div className="logo" aria-hidden="true"></div>
        <div>
          <div className="title">GM Auto Detailing</div>
          <div className="muted">Mobile detailing in East Sheen</div>
        </div>
      </div>
      <div className="badge">Stripe • Email confirmations</div>
    </header>
  );
}
function Stepper({ step }) {
  const labels = ["Details", "Service", "Time", "Confirm"];
  return (
    <div className="stepper">
      {labels.map((t, i) => (
        <div key={t} className={cx("step", step === i && "active")}>
          {i + 1}. {t}
        </div>
      ))}
    </div>
  );
}

/* ---------- main flow pages ---------- */
function Details({ onNext, state, setState }) {
  const [v, setV] = useState(
    state.customer || { name: "", phone: "", address: "", email: "" }
  );
  useEffect(() => setState((s) => ({ ...s, customer: v })), [v]);
  const { area, setArea, status } = useArea(v.address);

  const ok =
    v.name.trim().length > 1 &&
    v.phone.trim().length > 6 &&
    v.address.trim().length > 5;

  return (
    <div className="panel stack">
      <h2>Start your booking</h2>
      <div className="row">
        <input
          placeholder="Full name"
          value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
        />
        <input
          placeholder="Phone"
          value={v.phone}
          onChange={(e) => setV({ ...v, phone: e.target.value })}
        />
      </div>
      <input
        placeholder="Address (e.g. 'West ...' or 'East ...')"
        value={v.address}
        onChange={(e) => setV({ ...v, address: e.target.value })}
      />
      <input
        placeholder="Email (for confirmation)"
        value={v.email || ""}
        onChange={(e) => setV({ ...v, email: e.target.value })}
      />

      <div className="row">
        <div className="panel" style={{ flex: "1 1 260px" }}>
          <div className="muted">
            Service area (auto-detected{status === "denied" ? " off" : ""}):
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="badge">
              <input
                type="radio"
                name="area"
                checked={area === "left"}
                onChange={() => setArea("left")}
              />
              &nbsp;Left
            </label>
            <label className="badge">
              <input
                type="radio"
                name="area"
                checked={area === "right"}
                onChange={() => setArea("right")}
              />
              &nbsp;Right
            </label>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            {status === "asking" && "Detecting location…"}
            {status === "ok" && "Location detected."}
            {status === "denied" && "Geolocation denied; using your address text or manual selection."}
          </div>
        </div>
      </div>

      <div className="right">
        <button className="btn ghost" disabled>
          Back
        </button>
        <button
          className="btn primary"
          onClick={() => {
            setState((s) => ({ ...s, area }));
            onNext();
          }}
          disabled={!ok}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function Services({ onNext, onBack, state, setState, config }) {
  const [service, setService] = useState(state.service_key || "exterior");
  const [addons, setAddons] = useState(state.addons || []);
  useEffect(() => setState((s) => ({ ...s, service_key: service, addons })), [service, addons]);

  const svc = config?.services || {
    exterior: { name: "Exterior Detail", duration: 60, price: 60 },
    full: { name: "Full Detail", duration: 120, price: 120 },
    standard_membership: { name: "Standard Membership", includes: ["exterior", "exterior"], price: 100 },
    premium_membership: { name: "Premium Membership", includes: ["full", "full"], price: 220 },
  };
  const addonsCfg = config?.addons || {
    wax: { name: "Full Body Wax", price: 15 },
    polish: { name: "Hand Polish", price: 15 },
  };

  return (
    <div className="panel stack">
      <h2>Select your service</h2>
      <div className="cards">
        {Object.entries(svc).map(([key, val]) => (
          <div
            key={key}
            className={cx("card", service === key && "selected")}
            onClick={() => setService(key)}
          >
            <div style={{ fontWeight: 700 }}>{val.name}</div>
            {"price" in val && <div className="muted">{fmtGBP(val.price)}</div>}
            {"duration" in val && <div className="muted">{val.duration} min</div>}
            {"includes" in val && (
              <div className="muted">Includes: {val.includes.join(" + ")}</div>
            )}
          </div>
        ))}
      </div>

      <div>
        <h3 style={{ marginBottom: 6 }}>Add-ons (optional)</h3>
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

      <div className="right">
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <button className="btn primary" onClick={onNext}>
          See availability
        </button>
      </div>
    </div>
  );
}

function Calendar({ onNext, onBack, state, setState }) {
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const isMembership = state.service_key?.includes("membership");
  const [selected, setSelected] = useState(state.slot || null);
  const [selected2, setSelected2] = useState(state.membershipSlots || []);

  useEffect(() => {
    setLoading(true);
    const body = {
      service_key: state.service_key,
      addons: state.addons || [],
      area: state.area || "right",
    };
    fetch(API + "/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => setSlots(d.slots || []))
      .finally(() => setLoading(false));
  }, [state.service_key, state.addons, state.area]);

  const grouped = useMemo(() => {
    const g = {};
    for (const s of slots) {
      const k = dkey(s.start_iso);
      (g[k] ||= []).push(s);
    }
    return g;
  }, [slots]);
  const days = Object.keys(grouped).sort();

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
  const canContinue = isMembership ? selected2.length === 2 : !!selected;

  return (
    <div className={cx("panel", loading && "loading")}>
      <h2>Choose a time</h2>
      {days.length === 0 && !loading && (
        <div className="alert">No slots available. Try another service or date.</div>
      )}
      {days.map((k) => (
        <div key={k} className="day">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            {new Date(k).toLocaleDateString([], {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </div>
          {grouped[k].map((s) => {
            const sel = isMembership
              ? !!selected2.find((x) => x.start_iso === s.start_iso)
              : selected?.start_iso === s.start_iso;
            return (
              <span
                key={s.start_iso}
                className={cx("slot", sel && "sel")}
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
      ))}

      <div className="stickybar">
        <div className="muted">
          {isMembership
            ? `${selected2.length}/2 times selected`
            : selected
            ? dstr(selected.start_iso)
            : "Select a time"}
        </div>
        <div className="right">
          <button className="btn" onClick={onBack}>
            Back
          </button>
          <button
            className="btn primary"
            disabled={!canContinue}
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
      area: state.area || "right",
      service_key: state.service_key,
      addons: state.addons || [],
      slot: state.slot,
      membershipSlots: state.membershipSlots,
    };
    const res = await fetch(API + "/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json());
    if (res.ok) {
      alert("Booking successful! Check your email for confirmation.");
      setState({});
      location.href = "/";
    } else {
      alert("Error: " + (res.error || "Unknown"));
    }
  }

  return (
    <div className="panel stack">
      <h2>Confirm your booking</h2>
      <div className="row">
        <div className="panel" style={{ flex: "1 1 260px" }}>
          <div><b>Name:</b> {state.customer?.name}</div>
          <div><b>Phone:</b> {state.customer?.phone}</div>
          <div><b>Address:</b> {state.customer?.address}</div>
          <div><b>Area:</b> {state.area?.toUpperCase()}</div>
          <div><b>Service:</b> {state.service_key}</div>
          <div><b>Add-ons:</b> {(state.addons || []).join(", ") || "None"}</div>
          <div>
            <b>When:</b>{" "}
            {isMembership
              ? state.membershipSlots?.map((s) => dstr(s.start_iso)).join(" & ")
              : state.slot && dstr(state.slot.start_iso)}
          </div>
        </div>
        <div className="panel" style={{ flex: "1 1 260px" }}>
          <div className="muted">Total due</div>
          <div style={{ fontSize: 28, fontWeight: 800 }}>{fmtGBP(total)}</div>
          <div className="muted">Full payment upfront via Stripe</div>
        </div>
      </div>

      <div className="stickybar">
        <div><b>Total:</b> {fmtGBP(total)}</div>
        <div className="right">
          <button className="btn" onClick={onBack}>Back</button>
          <button className="btn primary" onClick={confirm}>Confirm & Pay</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- widget mode (compact embed) ---------- */
function Widget() {
  const [state, setState] = useState({ area: "right", service_key: "exterior" });
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(API + "/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_key: state.service_key,
        addons: [],
        area: state.area,
      }),
    })
      .then((r) => r.json())
      .then((d) => setSlots(d.slots?.slice(0, 10) || []))
      .finally(() => setLoading(false));
  }, [state.service_key, state.area]);

  return (
    <div className="widget">
      <div className="panel stack">
        <h2>Book now</h2>
        <div className="row">
          <select
            value={state.service_key}
            onChange={(e) => setState((s) => ({ ...s, service_key: e.target.value }))}
          >
            <option value="exterior">Exterior Detail</option>
            <option value="full">Full Detail</option>
            <option value="standard_membership">Standard Membership</option>
            <option value="premium_membership">Premium Membership</option>
          </select>
          <select
            value={state.area}
            onChange={(e) => setState((s) => ({ ...s, area: e.target.value }))}
          >
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </div>
        <div className={cx(loading && "loading")}>
          <div className="muted">Next available times:</div>
          <div>
            {slots.map((s) => (
              <span key={s.start_iso} className="slot">
                {dstr(s.start_iso)}
              </span>
            ))}
          </div>
        </div>
        <div className="right">
          <a className="btn primary" href="/">Open full booking</a>
        </div>
      </div>
    </div>
  );
}

/* ---------- admin (protected) ---------- */
function useAdminAuth() {
  const [token, setToken] = useState(localStorage.getItem("adminKey") || "");
  function ask() {
    const t = prompt("Admin passcode:");
    if (t) {
      localStorage.setItem("adminKey", t);
      setToken(t);
    }
  }
  function clear() {
    localStorage.removeItem("adminKey");
    setToken("");
  }
  return { token, ask, clear };
}
function Admin() {
  const { token, ask, clear } = useAdminAuth();
  const [rows, setRows] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [tips, setTips] = useState(0);

  useEffect(() => {
    if (!token) return;
    const H = { "x-admin-key": token };
    fetch(API + "/admin/bookings", { headers: H })
      .then((r) => r.json())
      .then((d) => setRows(d.bookings || []));
    fetch(API + "/admin/reviews", { headers: H })
      .then((r) => r.json())
      .then((d) => {
        setReviews(d.reviews || []);
        setTips(d.total_tips_gbp || 0);
      });
  }, [token]);

  if (!token) {
    return (
      <div className="panel">
        <h2>Admin</h2>
        <p className="muted">This area is protected.</p>
        <button className="btn primary" onClick={ask}>Enter passcode</button>
      </div>
    );
  }

  return (
    <div className="panel stack">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <h2>Admin — Bookings</h2>
        <button className="btn" onClick={clear}>Sign out</button>
      </div>
      <div className="row">
        <div className="panel" style={{flex:'1 1 260px'}}>
          <div className="muted">Total tips</div>
          <div style={{fontSize:24,fontWeight:800}}>{fmtGBP(tips)}</div>
        </div>
      </div>
      <div className="panel">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr><th>Start</th><th>End</th><th>Service</th><th>Client</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{borderBottom:'1px solid #e5e7eb'}}>
                <td>{dstr(r.start_iso)}</td>
                <td>{new Date(r.end_iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td>
                <td>{r.service_key}</td>
                <td>{r.name} — {r.phone}</td>
                <td>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Latest Reviews</h3>
      <div className="panel">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr><th>When</th><th>Client</th><th>Rating</th><th>Comments</th><th>Tip</th></tr></thead>
          <tbody>
            {reviews.slice(0,20).map((r) => (
              <tr key={r.id} style={{borderBottom:'1px solid #e5e7eb'}}>
                <td>{dstr(r.created_at)}</td>
                <td>{r.name} — {r.phone}</td>
                <td>{r.rating}</td>
                <td>{r.comments}</td>
                <td>{fmtGBP((r.tip_amount_pence||0)/100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- router ---------- */
function App() {
  const [state, setState] = useState({});
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState({ services: {}, addons: {} });
  useEffect(() => { fetch(API + "/config").then((r) => r.json()).then(setConfig).catch(()=>{}); }, []);
  return (
    <>
      <Header />
      <Stepper step={step} />
      {step === 0 && <Details onNext={() => setStep(1)} state={state} setState={setState} />}
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
          onNext={() => setStep(3)}
          onBack={() => setStep(1)}
          state={{ ...state }}
          setState={setState}
        />
      )}
      {step === 3 && <Confirm onBack={() => setStep(2)} state={state} setState={setState} />}
      <div className="footer muted">© GM Auto Detailing</div>
    </>
  );
}
function Router() {
  const path = location.pathname;
  if (path.startsWith("/widget")) return <Widget />;
  if (path.startsWith("/admin")) return <Admin />;
  return <App />;
}

createRoot(document.getElementById("root")).render(<Router />);
