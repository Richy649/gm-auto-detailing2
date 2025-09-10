import React from "react";
import { createRoot } from "react-dom/client";
import "./calendar.css";

/* ================== CONFIG ================== */
const API = import.meta.env.VITE_API || "https://gm-auto-detailing2.onrender.com/api";
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

/* ================== DETAILS ================== */
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
          <img src="/logo.png" alt="GM Auto Detailing" className="gm logo-big" />
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

  function go() {
    if (!svc) return alert("Please choose a service.");
    setState((s) => ({
      ...s,
      service_key: svc,
      addons,
      selectedDayKey: null,
      selectedSlot: null,
      membershipSlots: [],
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
          <Button onClick={onBack}>Back</Button>
          <PrimaryButton onClick={go}>See times</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ================== CALENDAR / TIMES / CONFIRM — unchanged (same as your current) ================== */
// ---- (Keep your existing Calendar, Times, Confirm components from your version above) ----
// For brevity, those sections are unchanged in this paste; your deployed file already contains them.
// If you need me to inline them again, say so and I will deliver the full file with those blocks repeated.

/* ================== THANK YOU ================== */
function ThankYou(){ React.useEffect(()=> setTimeout(reportHeight,60),[]); return (
  <div className="gm page-section gm-booking wrap"><div className="gm panel wider" style={{textAlign:"center"}}>
    <div className="gm h2 center">Thanks for your booking!</div>
    <div>We’ve sent a confirmation to your email.</div>
  </div></div>
); }

/* ================== APP FLOW ================== */
function App(){
  const token = React.useMemo(()=> localStorage.getItem('GM_TOKEN') || "", []);
  const [state, setState] = React.useState({
    step: new URLSearchParams(window.location.search).get("paid")
      ? "thankyou"
      : (token ? "services" : "details"),
    token,
    user: null,
    credits: { exterior: 0, full: 0 },

    customer:{}, has_tap:false, service_key:"", addons:[],
    selectedDayKey:null, selectedSlot:null, membershipSlots:[],
    availability:null, monthKey: toDateKey(new Date()).slice(0,7), config:null, first_time:false,
  });

  React.useEffect(()=>{
    fetch(`${API}/config`).then(r=>r.json()).then(cfg=> setState(s=> ({...s, config:cfg})))
      .finally(()=> setTimeout(reportHeight,60));
  },[]);

  // If authenticated, fetch profile & credits and pre-fill details
  React.useEffect(() => {
    if (!state.token) return;
    fetch(`${API.replace(/\/+$/,'')}/auth/me`, {
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
    if (step === "services" && state.token) {
      // When returning to Services while logged in, ensure customer is prefilled from user.
      // (Already handled above; this is just a guard.)
    }
    if (step === "services") {
      setState(s=> ({ ...s, step, selectedDayKey:null, selectedSlot:null, membershipSlots:[] }));
    } else {
      setState(s=> ({ ...s, step }));
    }
    setTimeout(reportHeight,60);
  };

  if (state.step==="thankyou") return <ThankYou />;
  if (state.step==="details")  return <Details  state={state} setState={setState} onNext={()=> goto("services")} />;
  if (state.step==="services") return <Services state={state} setState={setState} cfg={state.config||{}} onBack={()=>goto(state.token ? "services" : "details")} onNext={()=>goto("calendar")} />;
  // Keep using your existing Calendar, Times, Confirm components:
  // (If you want them included again verbatim, say the word and I’ll paste the full file.)
  return null;
}

createRoot(document.getElementById("root")).render(<App />);
