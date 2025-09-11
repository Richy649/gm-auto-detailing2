import React from "react";
import { createRoot } from "react-dom/client";
import "./calendar.css";

/* ================== CONFIG ================== */
const API_ROOT = "https://gm-auto-detailing2.onrender.com";
const API = `${API_ROOT}/api`;
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

/* ======== IFRAME helpers ======== */
function reportHeight() {
  const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight);
  try { window.parent.postMessage({ type: "GM_HEIGHT", height: h }, "*"); } catch {}
}
function parentScrollToTop() { try { window.parent.postMessage({ type: "GM_SCROLL_TOP" }, "*"); } catch {} }
window.addEventListener("load", reportHeight);
window.addEventListener("resize", () => setTimeout(reportHeight, 60));
setInterval(reportHeight, 900);

/* Buttons */
const Button = ({ children, className, ...props }) => <button className={cx("gm btn", className)} {...props}>{children}</button>;
const PrimaryButton = (props) => <Button className="primary" {...props} />;

/* Head icon */
const HeadIcon = ({ size=16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ verticalAlign:"middle" }}>
    <circle cx="12" cy="8" r="4" fill="#222" />
    <path d="M4 20c0-4 4-6 8-6s8 2 8 6" fill="#222" />
  </svg>
);

/* Cards */
function ServiceCard({ title, price, strike, selected, onClick }) {
  return (
    <div className={cx("gm card", selected && "selected")} onClick={onClick} role="button">
      <div className="gm card-title">{title}</div>
      {typeof strike === "number" && strike > price ? (
        <div className="gm price-row">
          <span className="gm price-now">{fmtGBP(price)}</span>
          <span className="gm price-strike">{fmtGBP(strike)}</span>
        </div>
      ) : (
        <div className="gm muted" style={{ fontWeight: 600, marginBottom: 6 }}>{fmtGBP(price)}</div>
      )}
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

/* ================== SERVICES ================== */
function Services({ state, setState }) {
  const cfg = state.config || { services:{}, addons:{} };
  const [svc, setSvc] = React.useState(state.service_key || "");
  const [addons, setAddons] = React.useState([]);
  const [firstTime, setFirstTime] = React.useState(false);

  // top right "View account"
  const TopRight = () => (
    <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:8 }}>
      <Button onClick={()=> window.location.href="/account.html"}>
        <span style={{ marginRight:6 }}>View account</span><HeadIcon />
      </Button>
    </div>
  );

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
  }, [state.customer?.email, state.customer?.phone, state.customer?.street]);

  React.useEffect(() => { setTimeout(reportHeight, 60); }, [svc, addons]);

  const basePrice = (k)=> (typeof cfg.services?.[k]?.price === "number") ? cfg.services[k].price : 0;
  const effPrice  = (k)=> firstTime ? basePrice(k) * 0.5 : basePrice(k);

  const hasFullCredit = (state.credits?.full || 0) > 0;
  const hasExteriorCredit = (state.credits?.exterior || 0) > 0;
  const usingCredits = hasFullCredit || hasExteriorCredit;

  // If the user has credits, force them to booking calendar immediately (no services page)
  React.useEffect(() => {
    if (usingCredits) {
      const inferred = hasFullCredit ? "full" : "exterior";
      setState(s => ({ ...s, service_key: inferred, addons: [], step: "calendar" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingCredits]);

  async function subscribeNow(tierKey){
    const token = state.token;
    if (!token) { try { window.top.location.href = "/login.html"; } catch { window.location.href = "/login.html"; } return; }
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
    if (!payload.customer.email) { alert("Your account is missing an email address."); return; }
    const r = await fetch(`${API}/memberships/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(()=> ({}));
    if (!d?.ok || !d?.url) { alert(d?.error || "Unable to start subscription."); return; }
    try { window.top.location.href = d.url; } catch { window.location.href = d.url; }
  }

  const aCfg = cfg.addons || {};
  const toggleWax    = () => setAddons((arr) => (arr.includes("wax")    ? arr.filter((x) => x !== "wax")    : [...arr, "wax"]));
  const togglePolish = () => setAddons((arr) => (arr.includes("polish") ? arr.filter((x) => x !== "polish") : [...arr, "polish"]));

  function continueFlow() {
    if (!svc) return alert("Please choose a service.");
    if (svc === "standard_membership" || svc === "premium_membership") { subscribeNow(svc); return; }
    setState((s) => ({
      ...s,
      service_key: svc,
      addons: usingCredits ? [] : addons,
      selectedDayKey: null,
      selectedSlot: null,
      step: "calendar",
      first_time: firstTime
    }));
    setTimeout(reportHeight, 60);
  }

  // Hide Standard/Premium tiles if the user already has an active sub (credits will renew)
  const hideStandard = state.subscriptions?.some?.(x => x.tier === "standard" && x.status === "active");
  const hidePremium  = state.subscriptions?.some?.(x => x.tier === "premium"  && x.status === "active");

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider">
        <TopRight />

        <div className="gm h2 center">Choose your service</div>

        <div className="gm cards">
          <ServiceCard title={cfg.services?.exterior?.name || "Exterior Detail"}
            price={effPrice("exterior")} strike={firstTime ? basePrice("exterior") : undefined}
            selected={svc==="exterior"} onClick={()=>setSvc("exterior")} />
          <ServiceCard title={cfg.services?.full?.name || "Full Detail"}
            price={effPrice("full")} strike={firstTime ? basePrice("full") : undefined}
            selected={svc==="full"} onClick={()=>setSvc("full")} />
          {!hideStandard && (
            <ServiceCard title={cfg.services?.standard_membership?.name || "Standard Membership (2 Exterior)"}
              price={effPrice("standard_membership")} strike={firstTime ? basePrice("standard_membership") : undefined}
              selected={svc==="standard_membership"} onClick={()=>setSvc("standard_membership")} />
          )}
          {!hidePremium && (
            <ServiceCard title={cfg.services?.premium_membership?.name || "Premium Membership (2 Full)"}
              price={effPrice("premium_membership")} strike={firstTime ? basePrice("premium_membership") : undefined}
              selected={svc==="premium_membership"} onClick={()=>setSvc("premium_membership")} />
          )}
        </div>

        {/* Show add-ons ONLY for Exterior/Full. Hide for memberships. */}
        {(svc==="exterior" || svc==="full") && !usingCredits && (
          <>
            <div className="gm h2 center" style={{ marginTop: 8 }}>Add-ons (optional)</div>
            <div className="gm addon-benefits two-col">
              <AddonCard title={aCfg.wax?.name || "Ceramic Wax"}
                price={typeof aCfg.wax?.price === "number" ? aCfg.wax.price : 10}
                desc="Adds gloss and water beading. Light protection between washes."
                align="left" selected={addons.includes("wax")} onToggle={toggleWax} />
              <AddonCard title={aCfg.polish?.name || "Hand Polish"}
                price={typeof aCfg.polish?.price === "number" ? aCfg.polish.price : 22.5}
                desc="Hand-finished shine. Softens light marks and brightens the paint."
                align="right" selected={addons.includes("polish")} onToggle={togglePolish} />
            </div>
          </>
        )}

        <div className="gm actions space bottom-stick">
          <div />
          <PrimaryButton onClick={continueFlow}>
            {(svc==="standard_membership"||svc==="premium_membership") ? "Subscribe" : "Continue"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ================== CALENDAR ================== */
let reqCounter = 0;
function Calendar({ state, setState }) {
  const monthKey = state.monthKey;
  const todayKey = toDateKey(new Date());
  const plus1 = new Date(); plus1.setMonth(plus1.getMonth() + 1);
  const limitKey = toDateKey(plus1);
  const earliestMonth = monthOfKey(todayKey);
  const latestMonth   = monthOfKey(limitKey);
  const canPrev = monthKey > earliestMonth;
  const canNext = monthKey < latestMonth;

  const daysMap = state.availability?.days || {};
  const [loading, setLoading] = React.useState(false);
  const [loadErr, setLoadErr] = React.useState(null);

  const dayKeys = React.useMemo(() => {
    const [y, m] = monthKey.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1, 12));
    const dow = (first.getUTCDay() + 6) % 7;
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
    const arr = (daysMap[k] || []);
    if (!arr.some(s => s.available)) return;
    setState((s)=> ({ ...s, selectedDayKey: k, selectedSlot: null, step: "times" }));
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
            <Button className="gm btn nav" disabled={!canPrev} onClick={()=> canPrev && setState(s=>({ ...s, monthKey: addMonthsYYYYMM(monthKey, -1) }))}>Back</Button>
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
                const orange = !green && state.selectedDayKey === k;
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
          <Button onClick={()=> setState(s=> ({ ...s, step: "services" }))}>Back</Button>
        </div>
      </div>
    </div>
  );
}

/* ================== TIMES ================== */
function Times({ state, setState }) {
  const dayKey = state.selectedDayKey;
  const all = (state.availability?.days?.[dayKey] || []).slice()
    .sort((a,b)=> new Date(a.start_iso) - new Date(b.start_iso));

  React.useEffect(() => { window.scrollTo({ top: 0, behavior: "instant" }); parentScrollToTop(); setTimeout(reportHeight, 50); }, []);

  function choose(slot){
    if (!slot.available) return;
    setState(s=> ({ ...s, selectedSlot: slot, selectedDayKey: dayKey, step: "confirm" }));
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
          <Button onClick={()=> setState(s=> ({ ...s, step: "calendar" }))}>Back</Button>
        </div>
      </div>
    </div>
  );
}

/* ================== CONFIRM ================== */
function Confirm({ state, setState }) {
  const cfg = state.config || { services:{}, addons:{} };
  const base = (typeof cfg.services?.[state.service_key]?.price === "number") ? cfg.services[state.service_key].price : 0;
  const addonsTotal = (state.addons || []).reduce((s,k)=> s + (typeof cfg.addons?.[k]?.price === "number" ? cfg.addons[k].price : 0), 0);
  const firstTime = !!state.first_time;
  const serviceAfter = firstTime ? base * 0.5 : base;
  const preDiscountTotal = base + addonsTotal;
  const finalTotal = serviceAfter + addonsTotal;

  const usingCredit =
    ((state.credits?.exterior||0) > 0 && state.service_key === "exterior") ||
    ((state.credits?.full||0)     > 0 && state.service_key === "full");

  async function pay(){
    if (!state.customer || !state.service_key) return;

    if (usingCredit) {
      const token = state.token;
      if (!token) { try { window.top.location.href = "/login.html"; } catch { window.location.href = "/login.html"; } return; }
      const payload = {
        service_key: state.service_key,
        slot: state.selectedSlot,
        addons: [],
        customer: state.customer,
        origin: window.location.origin
      };
      const r = await fetch(`${API}/credits/book-with-credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const d = await r.json().catch(()=> ({}));
      if (!d?.ok) { alert(d?.error || "Credit booking failed"); return; }
      if (d.url) { try { window.top.location.href = d.url; } catch { window.location.href = d.url; } return; }
      if (d.booked) {
        setState(s=> ({ ...s, step: "thankyou", thankyouKind: "credit" }));
        setTimeout(reportHeight, 60);
        return;
      }
      alert("Unexpected response."); return;
    }

    const payload = {
      customer: state.customer,
      has_tap: true,
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
              <div>Outhouse tap: Yes</div>
            </div>

            <div className="gm card">
              <div className="gm card-title">Booking</div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{(cfg.services?.[state.service_key]?.name) || state.service_key}</div>
              {slotLine}
              {!!(state.addons || []).length && !usingCredit && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontWeight: 600 }}>Add-ons</div>
                  <div>{state.addons.map((k)=> (cfg.addons?.[k]?.name || k)).join(", ")}</div>
                </div>
              )}
            </div>
          </div>

          <div className="gm card">
            <div className="gm card-title">Amount due</div>
            {usingCredit ? (
              <>
                <div className="gm total">{fmtGBP(0)}</div>
                <div className="gm muted" style={{marginTop:6}}>Service paid with 1 membership credit</div>
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
              <Button onClick={()=> setState(s=> ({ ...s, step: "times" }))}>Back</Button>
              <PrimaryButton onClick={pay}>{usingCredit ? "Confirm" : "Confirm & Pay"}</PrimaryButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================== THANK YOU ================== */
function ThankYou({ kind, onBook, onAccount }) {
  const isSub  = kind === "sub";
  const title  = isSub ? "Thank you for subscribing!" : "Thank you so much for booking with me!";
  const body   = isSub
    ? "You now have two credits on your account. I can’t wait to get your vehicle looking its best. Pick a time that suits you."
    : "Your booking is confirmed. I’m looking forward to seeing you and taking great care of your car. You’ll receive an email with the details.";

  return (
    <div className="gm page-section gm-booking wrap">
      <div className="gm panel wider" style={{ textAlign:"center" }}>
        <img className="gm logo-big" src="/logo.png" alt="GM Auto Detailing" />
        <div className="gm h2 center" style={{ fontSize:22, marginTop:10 }}>{title}</div>
        <div style={{ maxWidth: 600, margin: "8px auto 0" }}>{body}</div>

        <div style={{ marginTop: 16, display:"inline-flex", gap:10 }}>
          {isSub && <PrimaryButton onClick={onBook}>Book now</PrimaryButton>}
          <Button onClick={onAccount}><span style={{ marginRight:6 }}>View account</span><HeadIcon /></Button>
        </div>
      </div>
    </div>
  );
}

/* ================== APP ================== */
function App(){
  const urlParams = new URLSearchParams(window.location.search);
  const afterLogin = urlParams.get("afterLogin") === "1";
  const fromSub = urlParams.get("sub") === "1";
  const paid = urlParams.get("paid") === "1";
  const thankyouFlag = urlParams.get("thankyou") === "1";
  const flow = urlParams.get("flow"); // "oneoff" | "sub" | "credit"
  const sessionId = urlParams.get("session_id");

  const [state, setState] = React.useState({
    step: "loading",
    token: localStorage.getItem('GM_TOKEN') || "",
    user: null,
    credits: { exterior: 0, full: 0 },
    subscriptions: [],
    customer:{}, has_tap:true, service_key:"", addons:[],
    selectedDayKey:null, selectedSlot:null,
    availability:null, monthKey: toDateKey(new Date()).slice(0,7), config:null, first_time:false,
    thankyouKind: flow || null,
  });

  // Load config early
  React.useEffect(()=>{
    fetch(`${API}/config`).then(r=>r.json()).then(cfg=> setState(s=> ({...s, config:cfg})))
      .finally(()=> setTimeout(reportHeight,60));
  },[]);

  const loadProfile = React.useCallback(async (token) => {
    const r = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error("profile_failed");
    const d = await r.json();
    if (!(d.ok && d.user)) throw new Error("profile_failed");
    const user = d.user;
    const customer = {
      name: user.name || "",
      phone: user.phone || "",
      email: user.email || "",
      street: user.street || "",
      postcode: user.postcode || "",
    };
    const credits = d.credits || { exterior:0, full:0 };
    return { user, customer, credits };
  }, []);

  // Handle success redirects and initial routing
  React.useEffect(() => {
    (async () => {
      const token = localStorage.getItem('GM_TOKEN') || "";

      // If a payment success redirect occurred, ensure persistence (confirm) then show Thank You
      if (paid) {
        if (sessionId) {
          await fetch(`${API}/pay/confirm`, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ session_id: sessionId }) }).catch(()=>{});
        }
        setState(s => ({ ...s, step: "thankyou", thankyouKind: flow || (sessionId ? "oneoff" : "credit") }));
        return;
      }

      if (!afterLogin && !fromSub && !thankyouFlag) {
        try { window.top.location.href = "/login.html"; } catch { window.location.href = "/login.html"; }
        return;
      }

      if (!token) {
        try { window.top.location.href = "/login.html"; } catch { window.location.href = "/login.html"; }
        return;
      }

      try {
        const { user, customer, credits } = await loadProfile(token);
        if (fromSub && thankyouFlag && flow === "sub") {
          setState(s => ({ ...s, token, user, customer, credits, step: "thankyou", thankyouKind: "sub" }));
          return;
        }
        // If user has credits, take them straight to calendar
        const hasFull = (credits.full||0) > 0;
        const hasExt  = (credits.exterior||0) > 0;
        if (hasFull || hasExt) {
          const inferred = hasFull ? "full" : "exterior";
          setState(s => ({ ...s, token, user, customer, credits, service_key: inferred, addons: [], step: "calendar" }));
          return;
        }
        setState(s => ({ ...s, token, user, customer, credits, step: "services" }));
      } catch {
        localStorage.removeItem('GM_TOKEN');
        try { window.top.location.href = "/login.html"; } catch { window.location.href = "/login.html"; }
      }
    })();
  }, []); // eslint-disable-line

  // Thank you handlers
  const goAccount = React.useCallback(() => { window.location.href = "/account.html"; }, []);
  const goBookFromSub = React.useCallback(() => {
    const inferred = (state.credits.full||0) > 0 ? "full" : "exterior";
    setState(s => ({ ...s, service_key: inferred, addons: [], step: "calendar" }));
    window.history.replaceState(null, "", "/"); // clear query
  }, [state.credits]);

  if (state.step === "loading")   return null;
  if (state.step === "services")  return <Services state={state} setState={setState} />;
  if (state.step === "calendar")  return <Calendar state={state} setState={setState} />;
  if (state.step === "times")     return <Times    state={state} setState={setState} />;
  if (state.step === "confirm")   return <Confirm  state={state} setState={setState} />;
  if (state.step === "thankyou")  return <ThankYou kind={state.thankyouKind || "oneoff"} onBook={goBookFromSub} onAccount={goAccount} />;

  return null;
}

createRoot(document.getElementById("root")).render(<App />);
