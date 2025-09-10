import React from "react";
import { createRoot } from "react-dom/client";
import "./calendar.css";

/* ================== CONFIG ================== */
const API_ROOT = "https://gm-auto-detailing2.onrender.com"; // backend origin
const API = `${API_ROOT}/api`;
const TZ = "Europe/London";
const CURRENCY = "£";

/* Defaults used if /api/config hasn't loaded yet */
const DEFAULT_PRICES = { exterior: 40, full: 60, standard_membership: 70, premium_membership: 100 };
const DEFAULT_ADDONS  = { wax: 10,  polish: 22.5 };

/* ================== UTILS ================== */
const fmtGBP = (n) => `${CURRENCY}${(Math.round(n * 100) / 100).toFixed(2)}`;
const cx = (...a) => a.filter(Boolean).join(" ");
const pad = (n) => (n < 10 ? `0${n}` : `${n}`);

const toDateKey = (d) => {
  const s = new Date(d).toLocaleString("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const [day, mon, yr] = s.split("/");
  return `${yr}-${mon}-${day}`;
};
const fromKey = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); };
const monthOfKey = (key) => key.slice(0, 7);
const monthLabel = (yyyyMM) => new Date(fromKey(`${yyyyMM}-01`)).toLocaleString("en-GB", { timeZone: TZ, month: "long", year: "numeric" });
const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const addMonthsYYYYMM = (yyyyMM, delta) => {
  const [y, m] = yyyyMM.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1, 12)); d.setUTCMonth(d.getUTCMonth() + delta);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};
const keyFromISO = (iso) => toDateKey(new Date(iso));

/* ======== IFRAME helpers (Squarespace embed) ======== */
function reportHeight() {
  const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight);
  try { window.parent.postMessage({ type: "GM_HEIGHT", height: h }, "*"); } catch {}
}
function parentScrollToTop() { try { window.parent.postMessage({ type: "GM_SCROLL_TOP" }, "*"); } catch {} }
window.addEventListener("load", reportHeight);
window.addEventListener("resize", () => setTimeout(reportHeight, 60));
setInterval(reportHeight, 900);

/* ================== SIMPLE BUTTONS ================== */
const Button = ({ children, className, ...props }) => <button className={cx("gm btn", className)} {...props}>{children}</button>;
const PrimaryButton = (props) => <Button className="primary" {...props} />;

/* ================== CARDS ================== */
function ServiceCard({ title, price, strike, selected, onClick, note }) {
  return (
    <div className={cx("gm card", selected && "selected")} onClick={onClick} role="button">
      <div className="gm card-title">{title}</div>
      {typeof strike === "number" && strike > price ? (
        <div className="gm price-row">
          <span className="gm price-now">{fmtGBP(price)}</span>
          <span className="gm price-strike">{fmtGBP(strike)}</span>
        </div>
      ) : (
        <div className="gm muted" style={{ fontWeight: 500, marginBottom: 6 }}>{fmtGBP(price)}</div>
      )}
      {note ? <div className="gm muted" style={{fontSize:12}}>{note}</div> : null}
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

/* VALIDATION */
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim()); }
function validUKPhone(p) {
  const d = String(p || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+44")) return /^\+44\d{10}$/.test(d);
  if (d.startsWith("0"))   return /^0\d{10}$/.test(d);
  return false;
}

/* ================== DETAILS (for non-logged-in users) ================== */
function Details({ state, setState, onNext }) {
  const [form, setForm] = React.useState(state.customer || {});
  const [tap, setTap] = React.useState(state.has_tap ? "yes" : "");

  function go() {
    if (!String(form.name || "").trim())        return alert("Please enter your name.");
    if (!validUKPhone(form.phone))              return alert("Please enter a valid UK phone number.");
    if (!validEmail(form.email))                return alert("Please enter a valid email address.");
    if (!String(form.street || "").trim())      return alert("Please enter your street address.");
    if (!String(form.postcode || "").trim())    return alert("Please enter your postcode.");
    if (tap !== "yes")                          return alert("To proceed, you must have an outhouse tap.");
    setState((s) => ({ ...s, customer: form, has_tap: true }));
    onNext();
  }

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider">
        <div className="gm h2 center kalam-title">Welcome to the gmautodetailing.uk booking app.</div>

        <div className="gm details-grid">
          {/* Logo column */}
          <img src="/logo.png" alt="GM Auto Detailing" className="gm logo-big" />

          {/* Form column */}
          <div className="gm details-right">
            <div className="gm row">
              <input className="gm input" placeholder="Name" value={form.name || ""} onChange={(e) => setForm({ ...form, name: e.target.value })}/>
              <input className="gm input" placeholder="Phone (UK)" value={form.phone || ""} onChange={(e) => setForm({ ...form, phone: e.target.value })}/>
            </div>

            <div className="gm row one">
              <input className="gm input" placeholder="Email" value={form.email || ""} onChange={(e) => setForm({ ...form, email: e.target.value })}/>
            </div>

            <div className="gm row">
              <input className="gm input" placeholder="Street address" value={form.street || ""} onChange={(e) => setForm({ ...form, street: e.target.value })}/>
              <input className="gm input" placeholder="Postcode" value={form.postcode || ""} onChange={(e) => setForm({ ...form, postcode: e.target.value })}/>
            </div>

            <div className="gm card tap-card">
              <div className="gm card-title">Do you have an outhouse tap?</div>
              <div className="tap-choices">
                <button type="button" className={`tap-btn ${tap === "yes" ? "on" : ""}`} onClick={() => setTap("yes")} aria-pressed={tap === "yes"}>Yes</button>
                <button type="button" className={`tap-btn ${tap === "no" ? "on" : ""}`} onClick={() => setTap("no")} aria-pressed={tap === "no"}>No</button>
              </div>
            </div>

            <div className="gm actions end">
              <button className="gm btn primary" onClick={go}>Next</button>
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
  const [firstTime, setFirstTime] = React.useState(false);

  const sCfg = cfg.services || {};
  const aCfg = cfg.addons || {};

  React.useEffect(() => {
    const { email, phone, street } = state.customer || {};
    if (!email && !phone && !street) return;
    const qs = new URLSearchParams({ email: email || "", phone: phone || "", street: street || "" });
    fetch(`${API}/first-time?` + qs.toString())
      .then(r => r.json())
      .then(d => setFirstTime(!!d.first_time))
      .catch(() => setFirstTime(false))
      .finally(() => setTimeout(reportHeight, 60));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => { setTimeout(reportHeight, 60); }, [svc, addons]);

  function basePrice(k){ return (typeof sCfg[k]?.price === "number") ? sCfg[k].price : (DEFAULT_PRICES[k] || 0); }
  function effPrice(k){ return firstTime ? basePrice(k) * 0.5 : basePrice(k); }

  async function subscribeNow(tierKey){
    if (!state.token) {
      alert("Please log in to subscribe.");
      try { window.top.location.href = "/login.html"; } catch { window.location.href = "/login.html"; }
      return;
    }
    const tier = tierKey === "standard_membership" ? "standard" : "premium";
    const payload = {
      tier,
      customer: {
        name: state.customer?.name || "",
        phone: state.customer?.phone || "",
        email: state.customer?.email || "",
        street: state.customer?.street || "",
        postcode: state.customer?.postcode || "",
      },
      origin: window.location.origin,
    };
    try {
      const r = await fetch(`${API}/memberships/subscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(()=> ({}));
      if (!d?.ok || !d?.url) {
        alert(d?.error || "Unable to start subscription.");
        return;
      }
      try { window.top.location.href = d.url; } catch { window.location.href = d.url; }
    } catch {
      alert("Network error. Please try again.");
    }
  }

  function go() {
    if (!svc) return alert("Please choose a service.");
    // If a membership is selected, start subscription immediately (Option 2)
    if (svc === "standard_membership" || svc === "premium_membership") {
      subscribeNow(svc);
      return;
    }
    setState((s) => ({
      ...s,
      service_key: svc,
      addons,
      selectedDayKey: null,
      selectedSlot: null,
      first_time: firstTime
    }));
    setTimeout(reportHeight, 60);
    onNext();
  }

  const toggleWax    = () => setAddons((arr) => (arr.includes("wax")    ? arr.filter((x) => x !== "wax")    : [...arr, "wax"]));
  const togglePolish = () => setAddons((arr) => (arr.includes("polish") ? arr.filter((x) => x !== "polish") : [...arr, "polish"]));

  const creditNoteExterior = state.credits?.exterior > 0 ? "Use 1 credit" : "";
  const creditNoteFull     = state.credits?.full > 0 ? "Use 1 credit" : "";

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider">
        <div className="gm h2 center">Choose your service</div>

        <div className="gm cards">
          <ServiceCard title={sCfg.exterior?.name || "Exterior Detail"}
            price={effPrice("exterior")} strike={firstTime ? basePrice("exterior") : undefined}
            selected={svc==="exterior"} onClick={()=>setSvc("exterior")} note={creditNoteExterior}/>
          <ServiceCard title={sCfg.full?.name || "Full Detail"}
            price={effPrice("full")} strike={firstTime ? basePrice("full") : undefined}
            selected={svc==="full"} onClick={()=>setSvc("full")} note={creditNoteFull}/>
          <ServiceCard title={sCfg.standard_membership?.name || "Standard Membership (2 Exterior)"}
            price={effPrice("standard_membership")} strike={firstTime ? basePrice("standard_membership") : undefined}
            selected={svc==="standard_membership"} onClick={()=>setSvc("standard_membership")} />
          <ServiceCard title={sCfg.premium_membership?.name || "Premium Membership (2 Full)"}
            price={effPrice("premium_membership")} strike={firstTime ? basePrice("premium_membership") : undefined}
            selected={svc==="premium_membership"} onClick={()=>setSvc("premium_membership")} />
        </div>

        <div className="gm h2 center" style={{ marginTop: 8 }}>Add-ons (optional)</div>
        <div className="gm addon-benefits two-col">
          <AddonCard title={aCfg.wax?.name || "Ceramic Wax"}
            price={typeof aCfg.wax?.price === "number" ? aCfg.wax.price : DEFAULT_ADDONS.wax}
            desc="Adds gloss and water beading. Light protection between washes."
            align="left" selected={addons.includes("wax")} onToggle={toggleWax} />
          <AddonCard title={aCfg.polish?.name || "Hand Polish"}
            price={typeof aCfg.polish?.price === "number" ? aCfg.polish.price : DEFAULT_ADDONS.polish}
            desc="Hand-finished shine. Softens light marks and brightens the paint."
            align="right" selected={addons.includes("polish")} onToggle={togglePolish} />
        </div>

        <div className="gm actions space bottom-stick">
          <Button onClick={onBack} disabled={!!(svc==="standard_membership"||svc==="premium_membership") && false /* no back disable */}>Back</Button>
          <PrimaryButton onClick={go}>{(svc==="standard_membership"||svc==="premium_membership") ? "Subscribe" : "See times"}</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ================== CALENDAR ================== */
let reqCounter = 0;

function Calendar({ state, setState, onBack, onGoTimes }) {
  const monthKey = state.monthKey;

  const todayKey = toDateKey(new Date());
  const plus1 = new Date(); plus1.setMonth(plus1.getMonth() + 1);
  const limitKey = toDateKey(plus1);
  const earliestMonth = monthOfKey(todayKey);
  const latestMonth   = monthOfKey(limitKey);
  const canPrev = monthKey > earliestMonth;
  const canNext = monthKey < latestMonth;

  const daysMap = state.availability?.days || {};
  const selectedDayKey = state.selectedDayKey;

  const [loading, setLoading] = React.useState(false);
  const [loadErr, setLoadErr] = React.useState(null);

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

  const doFetch = React.useCallback((yyyyMM) => {
    const id = ++reqCounter;
    setLoading(true);
    setLoadErr(null);
    fetch(`${API}/availability?service_key=${encodeURIComponent(state.service_key)}&month=${yyyyMM}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { if (id !== reqCounter) return; setState(s => ({ ...s, availability: d, monthKey: d.month })); })
      .catch(err => { if (id !== reqCounter) return; console.error("[availability] load failed", err); setLoadErr("We’re having trouble loading availability."); })
      .finally(() => { if (id === reqCounter) setLoading(false); setTimeout(reportHeight, 60); });
  }, [setState, state.service_key]);

  React.useEffect(() => {
    if (!state.service_key) return;
    if (!state.availability || state.availability.month !== monthKey) doFetch(monthKey);
    else setTimeout(reportHeight, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.service_key, monthKey]);

  function pickDay(k){
    if (!k) return;
    const hasAny = Array.isArray(daysMap[k]) && daysMap[k].some(s => s.available);
    if (!hasAny) return;
    setState((s)=> ({ ...s, selectedDayKey: k }));
    onGoTimes?.();
  }

  function dayHasChosenTime(k){
    if (!state.selectedSlot) return false;
    return keyFromISO(state.selectedSlot.start_iso) === k;
  }

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider">
        <div className="gm monthbar-grid">
          <div className="gm monthnav-left">
            <Button className="gm btn nav" disabled={!canPrev} onClick={()=> canPrev && setState(s=>({ ...s, monthKey: addMonthsYYYYMM(monthKey, -1) }))}>Previous</Button>
          </div>
          <div className="gm monthtitle">{monthLabel(monthKey)}</div>
          <div className="gm monthnav-right">
            <div style={{ width: 1 }} />
            <Button className="gm btn nav" disabled={!canNext} onClick={()=> canNext && setState(s=>({ ...s, monthKey: addMonthsYYYYMM(monthKey, +1) }))}>Next</Button>
          </div>
        </div>

        {loading && <div className="gm alert">Loading availability…</div>}
        {loadErr && (
          <div className="gm alert">
            {loadErr}<Button className="gm btn" onClick={()=> doFetch(monthKey)} style={{ marginLeft: 8 }}>Retry</Button>
          </div>
        )}

        {state.availability?.month === monthKey ? (
          <>
            <div className="gm dowgrid">{weekdayNames.map((w)=> <div key={w} className="gm dow">{w}</div>)}</div>
            <div className="gm monthgrid">
              {dayKeys.map((k,i)=>{
                if (!k) return <div key={`b${i}`} className="gm dayblank" />;
                const arr = daysMap[k] || [];
                const hasFree = arr.some(s => s.available);
                const disabled = !hasFree;
                const green = dayHasChosenTime(k);
                const orange = !green && state.selectedDayKey === k; // selected but no time chosen
                return (
                  <div key={k} className="gm daywrap">
                    <button
                      className={cx("gm daycell", hasFree && "has", disabled && "off", green && "selected-green", orange && "selected-orange")}
                      onClick={()=> !disabled && pickDay(k)}
                      disabled={disabled}
                    >
                      {Number(k.slice(-2))}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

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
  const all = (state.availability?.days?.[dayKey] || []).slice()
    .sort((a,b)=> new Date(a.start_iso) - new Date(b.start_iso));

  React.useEffect(() => { window.scrollTo({ top: 0, behavior: "instant" }); parentScrollToTop(); setTimeout(reportHeight, 50); }, []);

  function choose(slot){
    if (!slot.available) return;
    setState(s=> ({ ...s, selectedSlot: slot, selectedDayKey: dayKey }));
  }

  const isOn = (slot) => state.selectedSlot?.start_iso === slot.start_iso;

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider">
        <div className="gm h2 center">
          {new Date(fromKey(dayKey)).toLocaleString("en-GB",{ timeZone:TZ, weekday:"long", day:"numeric", month:"long", year:"numeric" })}
        </div>

        <div className="gm timegrid">
          {all.map((s,i)=>{
            const start = new Date(s.start_iso).toLocaleString("en-GB",{ timeZone:TZ, hour:"2-digit", minute:"2-digit", hour12:false });
            const on = isOn(s);
            return (
              <div key={i} className="gm timebox-wrap">
                <button
                  className={cx("gm timebox", on && "timebox-on", !s.available && "timebox-off")}
                  onClick={()=> choose(s)}
                  disabled={!s.available}
                  title={!s.available ? "Already booked" : ""}
                >
                  {start}
                </button>
              </div>
            );
          })}
        </div>

        <div className="gm actions space" style={{ marginTop: 12 }}>
          <Button onClick={onBack}>Back to calendar</Button>
          <PrimaryButton onClick={onConfirm} disabled={!state.selectedSlot}>
            Continue
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ================== CONFIRM ================== */
function Confirm({ state, setState, onBack }) {
  const services = state.config?.services || {};
  const addonsCfg = state.config?.addons || {};
  const firstTime = !!state.first_time;

  const base =
    typeof services[state.service_key]?.price === "number"
      ? services[state.service_key].price
      : (DEFAULT_PRICES[state.service_key] || 0);

  const addonsTotal = (state.addons || []).reduce(
    (s, k) => s + (typeof addonsCfg[k]?.price === "number" ? addonsCfg[k].price : (DEFAULT_ADDONS[k] || 0)),
    0
  );

  const serviceAfter = firstTime ? base * 0.5 : base;
  const preDiscountTotal = base + addonsTotal;
  const finalTotal       = serviceAfter + addonsTotal;

  const usingCredit =
    (state.service_key === "exterior" && (state.credits?.exterior || 0) > 0) ||
    (state.service_key === "full"     && (state.credits?.full     || 0) > 0);

  async function pay(){
    if (!state.customer || !state.service_key) return;

    // 1) If using a credit, go through the credits API (auth required)
    if (usingCredit) {
      if (!state.token) {
        alert("Please log in to use your credits.");
        try { window.top.location.href = "/login.html"; } catch { window.location.href = "/login.html"; }
        return;
      }
      const payload = {
        service_key: state.service_key,
        slot: state.selectedSlot,
        addons: state.addons || [],
        customer: state.customer,
        origin: window.location.origin
      };
      try {
        const r = await fetch(`${API}/credits/book-with-credit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${state.token}`
          },
          body: JSON.stringify(payload)
        });
        const d = await r.json().catch(()=> ({}));
        if (!d?.ok) {
          alert(d?.error || "Credit booking failed");
          return;
        }
        if (d.url) {
          // Add-ons only payment needed
          try { window.top.location.href = d.url; } catch { window.location.href = d.url; }
          return;
        }
        if (d.booked) {
          // No add-ons: booking complete immediately
          setState(s=> ({ ...s, step: "thankyou" }));
          setTimeout(reportHeight, 60);
          return;
        }
        alert("Unexpected response.");
      } catch {
        alert("Network error. Please try again.");
      }
      return;
    }

    // 2) No credit → normal one-off payment session
    const payload = {
      customer: state.customer,
      has_tap: !!state.has_tap,
      service_key: state.service_key,
      addons: state.addons || [],
      origin: window.location.origin,
      slot: state.selectedSlot
    };
    const r = await fetch(`${API}/pay/create-checkout-session`, {
      method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload)
    });
    const d = await r.json().catch(()=> ({}));
    if (!d?.ok || !d?.url) { alert(d?.error || "Payment failed to initialize."); return; }
    try { window.top.location.href = d.url; } catch { window.location.href = d.url; }
  }

  const slotLine = state.selectedSlot
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
              <div>Outhouse tap: {state.has_tap ? "Yes" : "Yes" /* for now required to proceed */}</div>
            </div>

            <div className="gm card">
              <div className="gm card-title">Booking</div>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>{(state.config?.services?.[state.service_key]?.name) || state.service_key}</div>
              {slotLine}
              {!!(state.addons || []).length && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontWeight: 500 }}>Add-ons</div>
                  <div>{state.addons.map((k)=> (state.config?.addons?.[k]?.name || k)).join(", ")}</div>
                </div>
              )}
            </div>
          </div>

          <div className="gm card">
            <div className="gm card-title">Amount due</div>
            {usingCredit ? (
              <>
                <div className="gm total">{fmtGBP((state.addons||[]).reduce((s,k)=> s + (typeof addonsCfg[k]?.price === "number" ? addonsCfg[k].price : (DEFAULT_ADDONS[k] || 0)), 0))}</div>
                <div className="gm muted" style={{marginTop:6}}>Service paid with 1 credit</div>
              </>
            ) : firstTime ? (
              <div className="gm price-row big">
                <span className="gm total">{fmtGBP(finalTotal)}</span>
                <span className="gm price-strike">{fmtGBP(preDiscountTotal)}</span>
              </div>
            ) : (
              <div className="gm total">{fmtGBP(preDiscountTotal)}</div>
            )}
            <div className="gm actions end" style={{ marginTop: 10 }}>
              <Button onClick={onBack}>Back</Button>
              <PrimaryButton onClick={pay}>{usingCredit ? "Confirm" : "Confirm & Pay"}</PrimaryButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================== THANK YOU ================== */
function ThankYou(){ React.useEffect(()=> setTimeout(reportHeight,60),[]); return (
  <div className="gm page-section gm-booking wrap"><div className="gm panel wider" style={{textAlign:"center"}}>
    <div className="gm h2 center">Thanks for your booking!</div>
    <div>We’ve sent a confirmation to your email.</div>
  </div></div>
); }

/* ================== SUBSCRIPTION SUCCESS ================== */
function SubSuccess({ onBook }) {
  React.useEffect(()=> setTimeout(reportHeight,60),[]);
  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider" style={{textAlign:"center"}}>
        <div className="gm h2 center">Subscription active</div>
        <div className="gm muted" style={{marginBottom:10}}>
          Your monthly credits have been issued. You can book your visits now.
        </div>
        <PrimaryButton onClick={onBook}>Book now</PrimaryButton>
      </div>
    </div>
  );
}

/* ================== APP FLOW ================== */
function App(){
  const urlParams = new URLSearchParams(window.location.search);
  const token0 = localStorage.getItem('GM_TOKEN') || "";
  const initialStep = urlParams.get("paid")
    ? "thankyou"
    : (urlParams.get("sub") ? "sub_success" : (token0 ? "services" : "details"));

  const [state, setState] = React.useState({
    step: initialStep,
    token: token0,
    user: null,
    credits: { exterior: 0, full: 0 },

    customer:{}, has_tap:true, service_key:"", addons:[],
    selectedDayKey:null, selectedSlot:null,
    availability:null, monthKey: toDateKey(new Date()).slice(0,7), config:null, first_time:false,
  });

  React.useEffect(()=>{
    fetch(`${API}/config`).then(r=>r.json()).then(cfg=> setState(s=> ({...s, config:cfg})))
      .finally(()=> setTimeout(reportHeight,60));
  },[]);

  // If authenticated, fetch profile & credits and pre-fill details
  React.useEffect(() => {
    if (!state.token) return;
    fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${state.token}` }
    })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(d => {
      if (d.ok && d.user) {
        const user = d.user;
        const customer = {
          name: user.name || "",
          phone: user.phone || "",
          email: user.email || "",
          street: user.street || "",
          postcode: user.postcode || "",
        };
        setState(s => ({ ...s, user, credits: d.credits || { exterior:0, full:0 }, customer }));
      }
    })
    .catch(()=>{/* non-fatal */})
    .finally(()=> setTimeout(reportHeight,60));
  }, [state.token]);

  const goto=(step)=>{
    if (step === "services") {
      setState(s=> ({ ...s, step, selectedDayKey:null, selectedSlot:null }));
    } else {
      setState(s=> ({ ...s, step }));
    }
    setTimeout(reportHeight,60);
  };

  // Screens
  if (state.step==="thankyou")    return <ThankYou />;
  if (state.step==="sub_success") return <SubSuccess onBook={()=> goto("services")} />;
  if (state.step==="details")     return <Details  state={state} setState={setState} onNext={()=> goto("services")} />;
  if (state.step==="services")    return <Services state={state} setState={setState} cfg={state.config||{}} onBack={()=>goto(state.token ? "services" : "details")} onNext={()=>goto("calendar")} />;

  if (state.step==="calendar")    return <Calendar state={state} setState={setState} onBack={()=>goto("services")} onGoTimes={()=>goto("times")} />;
  if (state.step==="times")       return <Times    state={state} setState={setState} onBack={()=>goto("calendar")} onConfirm={()=>goto("confirm")} />;
  if (state.step==="confirm")     return <Confirm  state={state} setState={setState} onBack={()=>goto("times")} />;

  return null;
}

createRoot(document.getElementById("root")).render(<App />);
