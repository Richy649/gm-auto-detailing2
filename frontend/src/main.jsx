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
