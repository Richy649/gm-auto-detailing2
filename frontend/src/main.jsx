import React from "react";
import { createRoot } from "react-dom/client";
import "./calendar.css";

/* ================== CONFIG ================== */
const API = import.meta.env.VITE_API || "https://gm-auto-detailing2.onrender.com/api";
const TZ = "Europe/London";
const CURRENCY = "£";

/* ================== UTILS ================== */
const fmtGBP = (n) => `${CURRENCY}${(Math.round(n * 100) / 100).toFixed(2)}`;
const cx = (...a) => a.filter(Boolean).join(" ");
const pad = (n) => (n < 10 ? `0${n}` : `${n}`);

const toDateKey = (d) => {
  const s = new Date(d).toLocaleString("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const [day, mon, yr] = s.split("/");
  return `${yr}-${mon}-${day}`;
};
const fromKey = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // noon UTC avoids DST edges
};
const monthOfKey = (key) => key.slice(0, 7); // yyyy-mm
const monthLabel = (yyyyMM) => {
  const d = fromKey(`${yyyyMM}-01`);
  return d.toLocaleString("en-GB", { timeZone: TZ, month: "long", year: "numeric" });
};
const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const addMonthsYYYYMM = (yyyyMM, delta) => {
  const [y, m] = yyyyMM.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1, 12));
  d.setUTCMonth(d.getUTCMonth() + delta);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};

/* ======== IFRAME helpers (Squarespace embed) ======== */
function reportHeight() {
  const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight);
  try { window.parent.postMessage({ type: "GM_HEIGHT", height: h }, "*"); } catch {}
}
function parentScrollToTop() {
  try { window.parent.postMessage({ type: "GM_SCROLL_TOP" }, "*"); } catch {}
}
window.addEventListener("load", reportHeight);
window.addEventListener("resize", () => setTimeout(reportHeight, 60));
setInterval(reportHeight, 900);

/* ================== SIMPLE BUTTON ================== */
const Button = ({ children, className, ...props }) => (
  <button className={cx("gm btn", className)} {...props}>{children}</button>
);
const PrimaryButton = (props) => <Button className="primary" {...props} />;

/* ================== CARDS ================== */
function ServiceCard({ title, price, selected, onClick, children }) {
  return (
    <div className={cx("gm card", selected && "selected")} onClick={onClick} role="button">
      <div className="gm card-title">{title}</div>
      <div className="gm muted" style={{ fontWeight: 800, marginBottom: 6 }}>{fmtGBP(price)}</div>
      {children}
    </div>
  );
}
function AddonCard({ title, price, desc, align = "left", selected, onToggle }) {
  return (
    <div className={cx("gm benefit", selected && "on")} style={{ textAlign: align }}>
      <div className="benefit-title">
        <span className="benefit-name">{title}</span>
        <span className="benefit-price">{fmtGBP(price)}</span>
      </div>
      <div className="benefit-copy">{desc}</div>
      <div className={cx("benefit-actions", align === "right" ? "right" : "left")}>
        <Button onClick={onToggle}>{selected ? "Remove" : "Add"}</Button>
      </div>
    </div>
  );
}

/* ================== DETAILS (only place with logo) ================== */
function Details({ state, setState, onNext }) {
  const [form, setForm] = React.useState(state.customer || {});

  function go() {
    const required = ["name", "email", "phone", "street", "postcode"];
    for (const k of required) if (!String(form[k] || "").trim()) return alert("Please complete your details.");
    setState((s) => ({ ...s, customer: form }));
    onNext();
  }

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider">
        <div className="gm h2 center">Welcome to the gmautodetailing.uk booking app.</div>

        <div className="gm details-grid">
          {/* KEEP this logo */}
          <img src="/logo.png" alt="GM" className="gm logo-big" />
          <div className="gm details-right">
            <div className="gm row">
              <input className="gm input" placeholder="Name" value={form.name || ""} onChange={(e)=>setForm({ ...form, name:e.target.value })}/>
              <input className="gm input" placeholder="Phone" value={form.phone || ""} onChange={(e)=>setForm({ ...form, phone:e.target.value })}/>
            </div>
            <div className="gm row one">
              <input className="gm input" placeholder="Email" value={form.email || ""} onChange={(e)=>setForm({ ...form, email:e.target.value })}/>
            </div>
            <div className="gm row">
              <input className="gm input" placeholder="Street address" value={form.street || ""} onChange={(e)=>setForm({ ...form, street:e.target.value })}/>
              <input className="gm input" placeholder="Postcode" value={form.postcode || ""} onChange={(e)=>setForm({ ...form, postcode:e.target.value })}/>
            </div>
            <div className="gm actions end">
              <PrimaryButton onClick={go}>Next</PrimaryButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================== SERVICES ================== */
function Services({ state, setState, onBack, onNext, cfg }) {
  const [svc, setSvc] = React.useState(state.service_key || "");
  const [addons, setAddons] = React.useState(state.addons || []);
  const sCfg = cfg.services || {};
  const aCfg = cfg.addons || {};

  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setTimeout(reportHeight, 60);
    return () => { document.body.style.overflow = prev; };
  }, []);

  function go() {
    if (!svc) return alert("Please choose a service.");
    setState((s) => ({
      ...s,
      service_key: svc,
      addons,                    // addons allowed for all services (incl. memberships)
      selectedDayKey: null,
      selectedSlot: null,
      membershipSlots: [],
    }));
    onNext();
  }

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider">
        <div className="gm h2 center">Choose your service</div>

        <div className="gm cards">
          <ServiceCard title={sCfg.exterior?.name || "Exterior Detail"} price={sCfg.exterior?.price ?? 40}
            selected={svc === "exterior"} onClick={()=>setSvc("exterior")} />
          <ServiceCard title={sCfg.full?.name || "Full Detail"} price={sCfg.full?.price ?? 60}
            selected={svc === "full"} onClick={()=>setSvc("full")} />
          <ServiceCard title={sCfg.standard_membership?.name || "Standard Membership (2 Exterior)"} price={sCfg.standard_membership?.price ?? 70}
            selected={svc === "standard_membership"} onClick={()=>setSvc("standard_membership")} />
          <ServiceCard title={sCfg.premium_membership?.name || "Premium Membership (2 Full)"} price={sCfg.premium_membership?.price ?? 100}
            selected={svc === "premium_membership"} onClick={()=>setSvc("premium_membership")} />
        </div>

        <div className="gm h2 center" style={{ marginTop: 8 }}>Add-ons (optional)</div>
        <div className="gm addon-benefits two-col">
          <AddonCard
            title={aCfg.wax?.name || "Full Body Wax"}
            price={aCfg.wax?.price ?? 10}
            desc="Adds gloss and strong water beading. Light protection between washes."
            align="left"
            selected={addons.includes("wax")}
            onToggle={()=> setAddons((arr)=> arr.includes("wax") ? arr.filter(x=>x!=="wax") : [...arr,"wax"])}
          />
          <AddonCard
            title={aCfg.polish?.name || "Hand Polish"}
            price={aCfg.polish?.price ?? 22.5}
            desc="Hand-finished shine. Softens light marks and brightens the paint."
            align="right"
            selected={addons.includes("polish")}
            onToggle={()=> setAddons((arr)=> arr.includes("polish") ? arr.filter(x=>x!=="polish") : [...arr,"polish"])}
          />
        </div>

        <div className="gm actions space bottom-stick">
          <Button onClick={onBack}>Back</Button>
          <PrimaryButton onClick={go}>See times</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ================== CALENDAR ================== */
function Calendar({ state, setState, onBack, onGoTimes }) {
  const isMembership = state.service_key?.includes("membership");
  const monthKey = state.monthKey;

  // Clamp navigation to today → today+1m
  const todayKey = toDateKey(new Date());
  const plus1 = new Date(); plus1.setMonth(plus1.getMonth() + 1);
  const limitKey = toDateKey(plus1);
  const earliestMonth = monthOfKey(todayKey);
  const latestMonth = monthOfKey(limitKey);
  const canPrev = monthKey > earliestMonth;
  const canNext = monthKey < latestMonth;

  const daysMap = state.availability?.days || {};

  const dayKeys = React.useMemo(() => {
    const [y, m] = monthKey.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1, 12));
    const dow = (first.getUTCDay() + 6) % 7; // Monday=0
    const last = new Date(Date.UTC(y, m, 0, 12));
    const total = last.getUTCDate();
    const keys = [];
    for (let i = 0; i < dow; i++) keys.push(null);
    for (let d = 1; d <= total; d++) keys.push(`${y}-${pad(m)}-${pad(d)}`);
    return keys;
  }, [monthKey]);

  function loadMonth(yyyyMM) {
    fetch(`${API}/availability?service_key=${encodeURIComponent(state.service_key)}&month=${yyyyMM}`)
      .then((r)=>r.json())
      .then((d)=> setState((s)=>({ ...s, availability:d, monthKey:yyyyMM })))
      .finally(()=> setTimeout(reportHeight, 60));
  }

  React.useEffect(() => {
    if (!state.availability || state.availability.month !== monthKey) {
      loadMonth(monthKey);
    } else {
      setTimeout(reportHeight, 10);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.service_key, monthKey]);

  function pickDay(k) {
    if (!k) return;
    if (!daysMap[k] || daysMap[k].length === 0) return;
    setState((s)=>({ ...s, selectedDayKey:k }));
    onGoTimes?.();
  }

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider">
        <div className="gm monthbar-grid">
          <div className="gm monthnav-left">
            <Button className="gm btn nav" disabled={!canPrev} onClick={()=> canPrev && loadMonth(addMonthsYYYYMM(monthKey, -1))}>
              Previous
            </Button>
          </div>
          <div className="gm monthtitle">{monthLabel(monthKey)}</div>
          <div className="gm monthnav-right">
            {/* Membership counter only */}
            {isMembership ? (
              <div className={cx("gm counter", (state.membershipSlots.length >= 2 ? "ok" : "warn"))}>
                {state.membershipSlots.length}/2
              </div>
            ) : <div style={{ width: 1 }} />}
            <Button className="gm btn nav" disabled={!canNext} onClick={()=> canNext && loadMonth(addMonthsYYYYMM(monthKey, +1))}>
              Next
            </Button>
          </div>
        </div>

        <div className="gm dowgrid">
          {weekdayNames.map((w)=> <div key={w} className="gm dow">{w}</div>)}
        </div>

        <div className="gm monthgrid">
          {dayKeys.map((k, i) => {
            if (!k) return <div key={`b${i}`} className="gm dayblank" />;
            const has = !!(daysMap[k] && daysMap[k].length);

            // Strong disable rules:
            const earliest = state.availability?.earliest_key || todayKey;
            const latest   = state.availability?.latest_key   || limitKey;
            const disabled = !has || k < earliest || k > latest || k < todayKey;
            const sel = state.selectedDayKey === k;

            return (
              <div key={k} className="gm daywrap">
                <button
                  className={cx("gm daycell", has && "has", sel && "selected", disabled && "off")}
                  onClick={()=> !disabled && pickDay(k)}
                  disabled={disabled}
                >
                  {Number(k.slice(-2))}
                </button>
              </div>
            );
          })}
        </div>

        <div className="gm actions space" style={{ marginTop: 12 }}>
          <Button onClick={onBack}>Back</Button>
        </div>
      </div>
    </div>
  );
}

/* ================== TIMES ================== */
function Times({ state, setState, onBack, onConfirm }) {
  const dayKey = state.selectedDayKey;
  const list = (state.availability?.days?.[dayKey] || []).slice();
  const isMembership = state.service_key?.includes("membership");

  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    parentScrollToTop();
    setTimeout(reportHeight, 50);
  }, []);

  function choose(slot) {
    if (isMembership) {
      const idx = state.membershipSlots.findIndex((s) => s.day_key === dayKey);
      const next = state.membershipSlots.slice();
      if (idx >= 0) next.splice(idx, 1, { day_key: dayKey, slot });
      else { if (next.length >= 2) return; next.push({ day_key: dayKey, slot }); }
      setState((s) => ({ ...s, membershipSlots: next }));
    } else {
      setState((s) => ({ ...s, selectedSlot: slot }));
    }
  }
  function removePick(dk) {
    setState((s) => ({ ...s, membershipSlots: s.membershipSlots.filter((x) => x.day_key !== dk) }));
  }

  const counter = state.membershipSlots.length;

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider">
        <div className="gm h2 center">
          {new Date(fromKey(dayKey)).toLocaleString("en-GB", { timeZone: TZ, weekday:"long", day:"numeric", month:"long", year:"numeric" })}
        </div>

        {isMembership && (
          <div className="gm actions space" style={{ marginBottom: 8 }}>
            <div className={cx("gm counter", counter >= 2 ? "ok" : "warn")}>{counter}/2</div>
            <div />
          </div>
        )}

        <div className="gm timegrid">
          {list.map((s, i) => {
            const start = new Date(s.start_iso).toLocaleString("en-GB", { timeZone: TZ, hour:"2-digit", minute:"2-digit", hour12:false });
            const on = isMembership
              ? state.membershipSlots.some((x) => x.day_key === dayKey && x.slot.start_iso === s.start_iso)
              : state.selectedSlot?.start_iso === s.start_iso;

            return (
              <div key={i} className="gm timebox-wrap">
                <button className={cx("gm timebox", on && "timebox-on")} onClick={()=> choose(s)}>{start}</button>
                {isMembership && on && (<button className="gm closebtn" onClick={()=> removePick(dayKey)}>×</button>)}
              </div>
            );
          })}
        </div>

        <div className="gm actions space" style={{ marginTop: 12 }}>
          <Button onClick={onBack}>Back to calendar</Button>
          <PrimaryButton onClick={onConfirm} disabled={isMembership ? state.membershipSlots.length !== 2 : !state.selectedSlot}>
            Continue
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ================== CONFIRM ================== */
function Confirm({ state, setState, onBack }) {
  const isMembership = state.service_key?.includes("membership");
  const services = state.config?.services || {};
  const addonsCfg = state.config?.addons || {};
  const base = services[state.service_key]?.price ?? 0;
  const addonsTotal = (state.addons || []).reduce((s, k) => s + (addonsCfg[k]?.price ?? 0), 0);
  const total = base + addonsTotal;

  async function pay() {
    if (!state.customer || !state.service_key) return;
    const payload = {
      customer: state.customer,
      service_key: state.service_key,
      addons: state.addons || [], // addons for all services
      origin: window.location.origin,
      ...(isMembership
        ? { membershipSlots: state.membershipSlots.map((x) => x.slot) }
        : { slot: state.selectedSlot }),
    };
    const r = await fetch(`${API}/pay/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!d?.ok || !d?.url) { alert(d?.error || "Payment failed to initialize."); return; }
    try { window.top.location.href = d.url; } catch { window.location.href = d.url; }
  }

  const slotLines = isMembership
    ? state.membershipSlots.slice().sort((a,b)=> new Date(a.slot.start_iso)-new Date(b.slot.start_iso)).map((x,i)=>{
        const dt = new Date(x.slot.start_iso).toLocaleString("en-GB",{ timeZone:TZ, weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit", hour12:false });
        return <div key={i}>{dt}</div>;
      })
    : state.selectedSlot
      ? [<div key="1">{new Date(state.selectedSlot.start_iso).toLocaleString("en-GB",{ timeZone:TZ, weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit", hour12:false })}</div>]
      : null;

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider">
        <div className="gm h2 center">Confirm booking</div>

        <div className="gm twocol">
          <div>
            <div className="gm card" style={{ marginBottom: 10 }}>
              <div className="gm card-title">Your details</div>
              <div>{state.customer?.name}</div>
              <div>{state.customer?.phone}</div>
              <div>{state.customer?.email}</div>
              <div>{state.customer?.street}, {state.customer?.postcode}</div>
            </div>

            <div className="gm card">
              <div className="gm card-title">Booking</div>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>
                {services[state.service_key]?.name || state.service_key}
              </div>
              {slotLines}
              {!!(state.addons || []).length && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontWeight: 800 }}>Add-ons</div>
                  <div>{state.addons.map((k)=> addonsCfg[k]?.name || k).join(", ")}</div>
                </div>
              )}
            </div>
          </div>

          <div className="gm card">
            <div className="gm card-title">Amount due</div>
            <div className="gm total">{fmtGBP(total)}</div>
            <div className="gm actions end" style={{ marginTop: 10 }}>
              <Button onClick={onBack}>Back</Button>
              <PrimaryButton onClick={pay}>Confirm & Pay</PrimaryButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================== THANK YOU ================== */
function ThankYou() {
  React.useEffect(() => { setTimeout(reportHeight, 60); }, []);
  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider" style={{ textAlign: "center" }}>
        <div className="gm h2 center">Thanks for your booking!</div>
        <div>We’ve sent a confirmation to your email.</div>
      </div>
    </div>
  );
}

/* ================== APP FLOW ================== */
function App() {
  const [state, setState] = React.useState({
    step: new URLSearchParams(window.location.search).get("paid") ? "thankyou" : "details",
    customer: {},
    service_key: "",
    addons: [],
    selectedDayKey: null,
    selectedSlot: null,
    membershipSlots: [],
    availability: null,
    monthKey: toDateKey(new Date()).slice(0, 7), // yyyy-mm
    config: null,
  });

  // Load config once
  React.useEffect(() => {
    fetch(`${API}/config`)
      .then((r) => r.json())
      .then((cfg) => setState((s) => ({ ...s, config: cfg })))
      .finally(() => setTimeout(reportHeight, 60));
  }, []);

  // Load availability when service selected or month changes
  React.useEffect(() => {
    if (!state.service_key) return;
    fetch(`${API}/availability?service_key=${encodeURIComponent(state.service_key)}&month=${state.monthKey}`)
      .then((r) => r.json())
      .then((d) => {
        const keys = Object.keys(d.days || {}).sort();
        const first = keys[0] || null;
        setState((s) => ({ ...s, availability: d, selectedDayKey: first || s.selectedDayKey }));
      })
      .finally(() => setTimeout(reportHeight, 60));
  }, [state.service_key, state.monthKey]);

  const goto = (step) => { setState((s) => ({ ...s, step })); setTimeout(reportHeight, 60); };

  if (state.step === "thankyou") return <ThankYou />;

  if (state.step === "details")
    return <Details state={state} setState={setState} onNext={() => goto("services")} />;

  if (state.step === "services")
    return <Services state={state} setState={setState} cfg={state.config || {}} onBack={() => goto("details")} onNext={() => goto("calendar")} />;

  if (state.step === "calendar")
    return <Calendar state={state} setState={setState} onBack={() => goto("services")} onGoTimes={() => goto("times")} />;

  if (state.step === "times")
    return <Times state={state} setState={setState} onBack={() => goto("calendar")} onConfirm={() => goto("confirm")} />;

  if (state.step === "confirm")
    return <Confirm state={state} setState={setState} onBack={() => goto("times")} />;

  return null;
}

/* ================== BOOT ================== */
createRoot(document.getElementById("root")).render(<App />);
