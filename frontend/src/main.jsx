import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { DateTime } from "luxon";
import "./calendar.css";

/* ===================== API base ===================== */
const API = import.meta.env.VITE_API || "https://gm-auto-detailing2.onrender.com/api";
const TZ = "Europe/London";

/* ===================== helpers ===================== */
const fmtGBP = (n) => `£${(Math.round(n * 100) / 100).toFixed(2)}`;
const cx = (...a) => a.filter(Boolean).join(" ");
const hasKeys = (o) => o && typeof o === "object" && Object.keys(o).length > 0;
const keyLocal = (dt) => dt.setZone(TZ).toFormat("yyyy-LL-dd");
const dateFromKeyLocal = (key) => DateTime.fromFormat(key, "yyyy-LL-dd", { zone: TZ });

/* ===================== Header ===================== */
function Header({ size = "md" }) {
  return (
    <header className={cx("gm header", size === "lg" && "lg", size === "xl" && "xl")}>
      <img className="gm logo" src="/logo.png" alt="GM Auto Detailing" />
    </header>
  );
}

/* ===================== Details ===================== */
function Details({ onNext, state, setState }) {
  const [v, setV] = useState(
    state.customer || { name: "", street: "", postcode: "", email: "", phone: "" }
  );

  useEffect(() => {
    setState((s) => ({ ...s, customer: v }));
    sessionStorage.setItem("gm_state", JSON.stringify({ ...state, customer: v }));
    // eslint-disable-next-line
  }, [v]);

  const ok =
    v.name.trim().length > 1 &&
    v.street.trim().length > 5 &&
    v.postcode.trim().length >= 5 &&
    v.phone.trim().length > 6;

  return (
    <div className="gm page-section">
      <div className="gm details-grid">
        <div className="gm details-left">
          <img className="gm logo-big" src="/logo.png" alt="GM Auto Detailing" />
        </div>
        <div className="gm details-right">
          <p className="gm hero-note">
            Welcome to <b>gmautodetailing.uk</b> — we use your details so we arrive on time and at the right
            location.
          </p>
          <h2 className="gm h2 center">Your details</h2>

          <div className="gm row">
            <input className="gm input" placeholder="Full name" value={v.name}
                   onChange={(e) => setV({ ...v, name: e.target.value })} />
            <input className="gm input" placeholder="Phone" value={v.phone}
                   onChange={(e) => setV({ ...v, phone: e.target.value })} />
          </div>
          <div className="gm row">
            <input className="gm input" placeholder="Email (for confirmation)" value={v.email}
                   onChange={(e) => setV({ ...v, email: e.target.value })} />
            <input className="gm input" placeholder="Street address" value={v.street}
                   onChange={(e) => setV({ ...v, street: e.target.value })} />
          </div>
          <div className="gm row one">
            <input className="gm input" placeholder="Postcode (e.g. SW14 7XX)" value={v.postcode}
                   onChange={(e) => setV({ ...v, postcode: e.target.value.toUpperCase() })} />
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

/* ===================== Services ===================== */
function Services({ onNext, onBack, state, setState, config, cfgLoading, reloadConfig }) {
  const services = config.services || {};
  const addonsCfg = config.addons || {};

  if (!hasKeys(services)) {
    return (
      <div className="gm page-section">
        <Header size="xl" />
        <div className="gm panel center">
          <h2 className="gm h2">Loading services…</h2>
          <p className="gm muted">
            {cfgLoading ? "Fetching config from the server." : "Could not load config. Try again."}
          </p>
          <button className="gm btn" onClick={reloadConfig}>Retry</button>
          <div style={{ marginTop: 16 }}>
            <button className="gm btn" onClick={onBack}>Back</button>
          </div>
        </div>
      </div>
    );
  }

  const firstKey = Object.keys(services)[0];
  const [service, setService] = useState(
    state.service_key && services[state.service_key] ? state.service_key : firstKey
  );
  const [addons, setAddons] = useState(state.addons || []);

  useEffect(() => setState((s) => ({ ...s, addons })), [addons]);

  useEffect(() => {
    setState((s) => {
      const isMembership = service?.includes("membership");
      const next = { ...s, service_key: service };
      next.selectedDay = null;
      next.prefetchedDaySlots = [];
      if (isMembership) next.slot = null; else next.membershipSlots = [];
      sessionStorage.setItem("gm_state", JSON.stringify(next));
      return next;
    });
    // eslint-disable-next-line
  }, [service]);

  function toggleAddon(k) {
    setAddons((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));
  }

  const AddonCard = ({ k, title, price, desc, align }) => {
    const on = addons.includes(k);
    return (
      <div className={cx("gm benefit", on && "on")}>
        <div className="benefit-title">
          <span className="benefit-name">{title}</span>
          <span className="benefit-price">{fmtGBP(price)}</span>
        </div>
        <div className="benefit-copy">{desc}</div>
        <div className={cx("benefit-actions", align === "left" ? "left" : "right")}>
          <button type="button" className="gm btn" onClick={() => toggleAddon(k)}>
            {on ? "Remove" : "Add"}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="gm page-section">
      <Header size="xl" />
      <div className="gm panel">
        <h2 className="gm h2 center">Choose your service</h2>

        <div className="gm cards">
          {Object.entries(services).map(([key, val]) => {
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

        <div className="gm muted center heading-small">Add-ons (optional)</div>
        <div className="gm addon-benefits two-col">
          <AddonCard
            k="wax"
            title="Full Body Wax"
            price={addonsCfg.wax?.price ?? 10}
            desc="Durable gloss and water beading. Protects the paint between washes."
            align="left"
          />
          <AddonCard
            k="polish"
            title="Hand Polish"
            price={addonsCfg.polish?.price ?? 22.5}
            desc="Hand-finished clarity. Reduces light haze and brings back shine."
            align="right"
          />
        </div>

        <div className="gm actions bottom-stick">
          <button className="gm btn" onClick={onBack}>Back</button>
          <button className="gm btn primary" onClick={onNext}>See times</button>
        </div>
      </div>
    </div>
  );
}

/* ===================== Month grid with weekday header ===================== */
function MonthGrid({
  slotsByDay, selectedDay, setSelectedDay,
  monthCursor, setMonthCursor,
  membershipCount, isMembership, bookedDays, onRemoveDay
}) {
  const monthStart = DateTime.fromObject({ year: monthCursor.year, month: monthCursor.month, day: 1 }, { zone: TZ });
  const monthTitle = monthStart.toFormat("LLLL yyyy");
  const daysInMonth = monthStart.daysInMonth;

  // Nav: current month ↔ month that contains (today + 1 month)
  const now = DateTime.now().setZone(TZ).startOf("month");
  const horizon = DateTime.now().setZone(TZ).plus({ months: 1 });
  const horizonMonthStart = horizon.startOf("month");

  const ym = (d) => d.year * 12 + d.month;
  const prevDisabled = ym(monthStart) <= ym(now);
  const nextDisabled = ym(monthStart) >= ym(horizonMonthStart);

  // Limit endDay to horizon day if this is the horizon month
  let endDay = daysInMonth;
  if (monthStart.hasSame(horizon, "month")) {
    endDay = Math.min(endDay, horizon.day);
  }

  // Weekday header (Mon..Sun)
  const dows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // Leading blanks: Luxon Monday=1..Sunday=7 => offset 0..6
  const leading = (monthStart.weekday + 6) % 7;

  const cells = [];
  for (let i = 0; i < leading; i++) cells.push(<div key={`blank-${i}`} className="gm dayblank" />);
  for (let day = 1; day <= endDay; day++) {
    const d = monthStart.set({ day });
    const k = d.setZone(TZ).toFormat("yyyy-LL-dd");
    const has = !!slotsByDay[k];
    const selected = selectedDay === k;
    const chosen = bookedDays.includes(k);

    cells.push(
      <div key={k} className="gm daywrap">
        <button
          className={cx("gm daycell", has && "has", selected && "selected", chosen && "chosen")}
          disabled={!has || chosen}
          onClick={() => setSelectedDay(k)}
          title={d.toLocaleString(DateTime.DATE_FULL)}
          type="button"
        >
          {day}
        </button>
        {isMembership && chosen && (
          <button
            type="button" aria-label="Remove this booked day" className="gm closebtn"
            onClick={(e) => { e.stopPropagation(); onRemoveDay(k); }}
            title="Remove this booking"
          >×</button>
        )}
      </div>
    );
  }

  return (
    <div className="gm calwrap">
      <div className="gm monthbar-grid">
        <div className="gm monthnav-left">
          <button className="gm btn nav" disabled={prevDisabled}
            onClick={() => !prevDisabled && setMonthCursor(monthStart.minus({ months: 1 }))}>
            Previous
          </button>
        </div>

        <div className="gm monthtitle">{monthTitle}</div>

        <div className="gm monthnav-right">
          {isMembership && (
            <span className={cx("gm counter", (membershipCount >= 2) ? "ok" : "warn")}>
              {membershipCount}/2
            </span>
          )}
          <button className="gm btn nav" disabled={nextDisabled}
            onClick={() => !nextDisabled && setMonthCursor(monthStart.plus({ months: 1 }))}>
            Next
          </button>
        </div>
      </div>

      <div className="gm dowgrid">
        {dows.map((d) => <div key={d} className="gm dow">{d}</div>)}
      </div>

      <div className="gm monthgrid">{cells}</div>
    </div>
  );
}

/* ===================== Calendar (fetch availability) ===================== */
function Calendar({ onNext, onBack, state, setState }) {
  const isMembership = state.service_key?.includes("membership");

  const [slotsByDay, setSlotsByDay] = useState({});
  const [selectedDay, setSelectedDay] = useState(state.selectedDay || null);
  const [monthCursor, setMonthCursor] = useState(DateTime.now().setZone(TZ));

  async function loadMonth(dt) {
    const monthStr = dt.toFormat("yyyy-LL");
    const url = `${API}/availability?service_key=${encodeURIComponent(state.service_key)}&month=${monthStr}`;
    const data = await fetch(url).then(r => r.json());
    if (!data?.ok) throw new Error(data?.error || "availability failed");
    setSlotsByDay(data.days || {});
    const keys = Object.keys(data.days || {}).sort();
    if (!selectedDay && keys.length) {
      setSelectedDay(keys[0]);
      setState((s) => ({ ...s, selectedDay: keys[0], prefetchedDaySlots: data.days[keys[0]] || [] }));
    } else if (selectedDay && data.days[selectedDay]) {
      setState((s) => ({ ...s, prefetchedDaySlots: data.days[selectedDay] }));
    } else if (selectedDay && !data.days[selectedDay]) {
      setState((s) => ({ ...s, selectedDay: null, prefetchedDaySlots: [] }));
      setSelectedDay(null);
    }
  }

  useEffect(() => { loadMonth(monthCursor); /* eslint-disable-next-line */}, [state.service_key, monthCursor.toISO()]);

  const bookedDays = (state.membershipSlots || []).map(s => keyLocal(DateTime.fromISO(s.start_iso).setZone(TZ)));
  const selectedIsBooked = bookedDays.includes(selectedDay || "");
  const currentDaySlots = selectedDay ? (slotsByDay[selectedDay] || []) : [];

  const onPickDay = (k) => {
    if (!bookedDays.includes(k)) {
      setSelectedDay(k);
      setState((s) => ({ ...s, selectedDay: k, prefetchedDaySlots: slotsByDay[k] || [] }));
    }
  };
  const onRemoveDay = (dayKey) => {
    setState((st) => ({
      ...st,
      membershipSlots: (st.membershipSlots || []).filter(s => keyLocal(DateTime.fromISO(s.start_iso).setZone(TZ)) !== dayKey),
    }));
  };

  return (
    <div className="gm page-section">
      <Header size="xl" />
      <div className="gm panel wider">
        <h2 className="gm h2 center">Pick a date</h2>

        <MonthGrid
          slotsByDay={slotsByDay}
          selectedDay={selectedDay}
          setSelectedDay={onPickDay}
          monthCursor={monthCursor}
          setMonthCursor={setMonthCursor}
          bookedDays={bookedDays}
          membershipCount={(state.membershipSlots || []).length}
          isMembership={isMembership}
          onRemoveDay={onRemoveDay}
        />

        {isMembership && selectedIsBooked && (
          <div className="gm note">
            You’ve already booked <b>{dateFromKeyLocal(selectedDay).toLocaleString(DateTime.DATE_MED_WITH_WEEKDAY)}</b>.
            Please pick a different day.
          </div>
        )}

        <div className="gm actions">
          <button className="gm btn" onClick={onBack}>Back</button>
          <button
            className="gm btn primary"
            disabled={!selectedDay || selectedIsBooked}
            onClick={() => { setState((s) => ({ ...s, selectedDay, prefetchedDaySlots: currentDaySlots })); onNext(); }}
          >
            See times
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===================== Times (no logo here) ===================== */
function Times({ onNext, onBack, state, setState }) {
  const isMembership = state.service_key?.includes("membership");
  const selectedDay = state.selectedDay;
  const [daySlots, setDaySlots] = useState(state.prefetchedDaySlots || []);

  useEffect(() => { setDaySlots(state.prefetchedDaySlots || []); }, [state.prefetchedDaySlots]);

  const selected =
    isMembership
      ? (state.membershipSlots || []).find((s) => s && keyLocal(DateTime.fromISO(s.start_iso).setZone(TZ)) === selectedDay)
      : state.slot && keyLocal(DateTime.fromISO(state.slot.start_iso).setZone(TZ)) === selectedDay
        ? state.slot
        : null;

  function choose(slot) {
    if (!isMembership) { setState((st) => ({ ...st, slot })); return; }
    setState((st) => {
      const ms = Array.isArray(st.membershipSlots) ? [...st.membershipSlots] : [];
      const dayK = keyLocal(DateTime.fromISO(slot.start_iso).setZone(TZ));
      const idxSameDay = ms.findIndex(x => keyLocal(DateTime.fromISO(x.start_iso).setZone(TZ)) === dayK);
      if (idxSameDay !== -1) { ms[idxSameDay] = slot; return { ...st, membershipSlots: ms }; }
      if (ms.some(x => keyLocal(DateTime.fromISO(x.start_iso).setZone(TZ)) === dayK)) return { ...st, membershipSlots: ms };
      if (ms.length < 2) return { ...st, membershipSlots: [...ms, slot] };
      return { ...st, membershipSlots: [ms[0], slot] };
    });
  }

  function removeSelectedSlot(slot) {
    if (!isMembership) setState((st) => ({ ...st, slot: null }));
    else setState((st) => ({ ...st, membershipSlots: (st.membershipSlots || []).filter((x) => x.start_iso !== slot.start_iso) }));
  }

  const canNext = isMembership ? ((state.membershipSlots||[]).length > 0) : !!selected;
  const headerDateObj = selected
    ? DateTime.fromISO(selected.start_iso).setZone(TZ)
    : dateFromKeyLocal(selectedDay);

  return (
    <div className="gm page-section">
      <div className="gm panel wider">
        <h2 className="gm h2 center" style={{ marginBottom: 16 }}>
          {headerDateObj.toLocaleString(DateTime.DATE_HUGE)}
        </h2>

        <div className="gm timegrid">
          {daySlots.map((s)=> {
            const sel = selected?.start_iso === s.start_iso ||
                        (isMembership && (state.membershipSlots||[]).some(x=>x.start_iso===s.start_iso));
            const t = DateTime.fromISO(s.start_iso).setZone(TZ).toFormat("HH:mm");
            return (
              <div key={s.start_iso} className="gm timebox-wrap">
                <button className={cx("gm timebox", sel && "timebox-on")} onClick={()=>choose(s)} type="button">
                  {t}
                </button>
                {sel && (
                  <button type="button" aria-label="Remove this booking" className="gm closebtn"
                          onClick={(e) => { e.stopPropagation(); removeSelectedSlot(s); }} title="Remove this booking">×</button>
                )}
              </div>
            );
          })}
        </div>

        <div className="gm actions end">
          <button className="gm btn" onClick={onBack}>Back to calendar</button>
          <button className="gm btn primary" disabled={!canNext}
                  onClick={() => { if (isMembership && (state.membershipSlots||[]).length === 1) onBack(); else onNext(); }}>
            {isMembership && (state.membershipSlots||[]).length === 1 ? "Choose second date" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===================== Confirm (Stripe) ===================== */
function Confirm({ onBack, state }) {
  const [loading, setLoading] = useState(false);

  const total = useMemo(() => {
    const cfg = JSON.parse(sessionStorage.getItem("gm_cfg") || "{}");
    const map = cfg.services || {};
    const addonsMap = cfg.addons || {};
    let t = map[state.service_key]?.price || 0;
    t += (state.addons || []).reduce((s, k) => s + (addonsMap[k]?.price || 0), 0);
    return t;
  }, [state.service_key, state.addons]);

  async function confirm() {
    if (loading) return;
    setLoading(true);
    try {
      const payload = {
        customer: state.customer,
        service_key: state.service_key,
        addons: state.addons || [],
        slot: state.slot,
        membershipSlots: state.membershipSlots,
        origin: window.location.origin // backend fallback if env missing
      };
      const resp = await fetch(`${API}/pay/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(()=> ({}));
      if (!resp.ok || !data?.ok || !data?.url) throw new Error(data?.error || `HTTP ${resp.status}`);
      window.location.href = data.url;
    } catch (err) {
      alert(`Checkout failed:\n${String(err.message || err)}\n\nPlease try again or contact us.`);
    } finally { setLoading(false); }
  }

  const when = state.service_key?.includes("membership")
    ? (state.membershipSlots || []).map((s) => DateTime.fromISO(s.start_iso).setZone(TZ).toFormat("ccc d LLL HH:mm")).join(" & ")
    : state.slot && DateTime.fromISO(state.slot.start_iso).setZone(TZ).toFormat("ccc d LLL HH:mm");

  return (
    <div className="gm page-section">
      <Header size="lg" />
      <div className="gm panel">
        <h2 className="gm h2 center">Confirm Booking</h2>

        <div className="gm twocol">
          <div className="gm panel sub">
            <div><b>Date & time:</b> {when || "—"}</div>
            <div><b>Name:</b> {state.customer?.name}</div>
            <div><b>Street:</b> {state.customer?.street}</div>
            <div><b>Postcode:</b> {state.customer?.postcode}</div>
            <div><b>Email:</b> {state.customer?.email}</div>
            <div><b>Phone:</b> {state.customer?.phone}</div>
            <div><b>Service:</b> {state.service_key}</div>
            <div><b>Add-ons:</b> {(state.addons||[]).join(", ") || "None"}</div>
          </div>
          <div className="gm panel sub center">
            <div className="gm muted">Amount due</div>
            <div className="gm total">{fmtGBP(total)}</div>
          </div>
        </div>

        <div className="gm actions space">
          <button className="gm btn" onClick={onBack} disabled={loading}>Back</button>
          <button className="gm btn primary" onClick={confirm} disabled={loading}>
            {loading ? "Starting checkout…" : "Confirm & Pay"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===================== Thank You ===================== */
function ThankYou() {
  return (
    <div className="gm page-section">
      <Header />
      <div className="gm panel center">
        <h2 className="gm h2">Thank you for your booking! 🎉</h2>
        <p className="gm muted">
          A confirmation will be sent to your email. If you don’t see it, please check your spam folder.
        </p>
        <button className="gm btn primary" onClick={() => { window.history.replaceState({}, "", "/"); window.location.reload(); }}>
          Back to start
        </button>
      </div>
    </div>
  );
}

/* ===================== App ===================== */
function App() {
  const [state, setState] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem("gm_state") || "{}"); } catch { return {}; }
  });
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState({ services: {}, addons: {} });
  const [cfgLoading, setCfgLoading] = useState(true);

  const fetchConfig = async (attempt = 1) => {
    try {
      setCfgLoading(true);
      const r = await fetch(API + "/config", { cache: "no-store" });
      const d = await r.json();
      setConfig(d || {});
      sessionStorage.setItem("gm_cfg", JSON.stringify(d || {}));
      setCfgLoading(false);
    } catch (e) {
      if (attempt < 3) setTimeout(() => fetchConfig(attempt + 1), 400 * attempt);
      else setCfgLoading(false);
    }
  };

  useEffect(() => {
    const qp = new URLSearchParams(window.location.search);
    if (qp.get("paid") === "1") setStep(5);
    else if (qp.get("cancelled") === "1") alert("Payment cancelled. Your booking wasn’t completed.");
  }, []);

  useEffect(() => { fetchConfig(); }, []);

  const services = hasKeys(config.services) ? config.services : {};

  return (
    <div className="gm-site">
      <div className="gm-booking wrap">
        {step === 0 && <Details onNext={() => setStep(1)} state={state} setState={setState} />}
        {step === 1 && <Services onNext={() => setStep(2)} onBack={() => setStep(0)} state={state} setState={setState} config={config} cfgLoading={cfgLoading} reloadConfig={fetchConfig} />}
        {step === 2 && <Calendar onNext={() => setStep(3)} onBack={() => { setState((s) => ({ ...s, selectedDay: null, slot: null, membershipSlots: [], prefetchedDaySlots: [] })); setStep(1); }} state={state} setState={setState} />}
        {step === 3 && <Times onNext={() => setStep(4)} onBack={() => setStep(2)} state={state} setState={setState} />}
        {step === 4 && <Confirm onBack={() => setStep(3)} state={state} setState={setState} />}
        {step === 5 && <ThankYou />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
