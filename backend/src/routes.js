import { Router } from "express";
import { getBookingsBetween, hasExistingCustomer } from "./db.js";

const router = Router();

/* ---------- Public config ---------- */
router.get("/config", (_req, res) => {
  res.json({
    services: {
      exterior: { name: "Exterior Detail", price: 40 },
      full: { name: "Full Detail", price: 60 },
      standard_membership: { name: "Standard Membership (2 Exterior)", price: 70 },
      premium_membership: { name: "Premium Membership (2 Full)", price: 100 },
    },
    addons: {
      wax: { name: "Full Body Wax", price: 10 },
      polish: { name: "Hand Polish", price: 22.5 },
    },
  });
});

/* ---------- Availability (returns ALL slots; each has available:true|false) ---------- */
const TZ = "Europe/London";
const SERVICE_DURATION = { exterior:75, full:120, standard_membership:75, premium_membership:120 };
const BUFFER_MIN = 30;
const OVERRUN_MAX_MIN = 45;

const pad = (n)=> (n<10?`0${n}`:`${n}`);
const toKey = (d) => {
  const s = new Date(d).toLocaleString("en-GB",{ timeZone:TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  const [dd,mm,yyyy] = s.split("/");
  return `${yyyy}-${mm}-${dd}`;
};
const fromKeyNoonUTC = (key) => { const [y,m,d]=key.split("-").map(Number); return new Date(Date.UTC(y,m-1,d,12,0,0)); };
const monthOfKey = (key) => key.slice(0,7);
const hm = (str)=> { const [h,m]=str.split(":").map(Number); return h*60+(m||0); };

function londonOffsetMinutes(dayKey){
  const dt = fromKeyNoonUTC(dayKey);
  const hour = Number(dt.toLocaleString("en-GB",{ timeZone:TZ, hour:"2-digit", hour12:false }));
  return (hour - 12) * 60;
}
function londonLocalToUTCISO(dayKey, hh, mm){
  const [y,m,d] = dayKey.split("-").map(Number);
  const offset = londonOffsetMinutes(dayKey);
  const localMin = hh*60 + mm;
  const utcMin = localMin - offset;
  const base = Date.UTC(y,m-1,d,0,0,0);
  return new Date(base + utcMin*60*1000).toISOString();
}
function isWeekend(dayKey){ const dow = fromKeyNoonUTC(dayKey).getUTCDay(); return dow===0 || dow===6; }
function overlaps(aS, aE, bS, bE){ return new Date(aS) < new Date(bE) && new Date(aE) > new Date(bS); }

function generateStarts(dayKey, durationMin){
  const wknd = isWeekend(dayKey);
  const startMin = wknd ? hm("09:00") : hm("16:00");
  const endMin   = wknd ? hm("19:30") : hm("21:00");
  const hardEnd = endMin + OVERRUN_MAX_MIN;

  const res=[]; let t=startMin;
  while (t + durationMin <= hardEnd){
    res.push(t);
    t = t + durationMin + BUFFER_MIN;
  }
  return res.filter(s => s + durationMin <= hardEnd);
}

function slotsForDay(dayKey, serviceKey){
  const dur = SERVICE_DURATION[serviceKey] ?? 75;
  return generateStarts(dayKey, dur).map(m => {
    const sh = Math.floor(m/60), sm = m%60;
    const eh = Math.floor((m+dur)/60), em = (m+dur)%60;
    return {
      start_iso: londonLocalToUTCISO(dayKey, sh, sm),
      end_iso:   londonLocalToUTCISO(dayKey, eh, em),
    };
  });
}

router.get("/availability", async (req, res) => {
  try {
    const service_key = String(req.query.service_key || "exterior").trim();
    const monthParam  = String(req.query.month || "").trim();

    // 24h cutoff: earliest selectable is now + 24h (tomorrow in practice)
    const now = new Date();
    const minStart = new Date(now.getTime() + 24*60*60*1000);
    const earliestKey = toKey(minStart);

    // Latest day = now + 1 month (inclusive by key compare)
    const plus1 = new Date(); plus1.setMonth(plus1.getMonth()+1);
    const latestKey = toKey(plus1);

    const month = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : monthOfKey(earliestKey);
    const [y,m] = month.split("-").map(Number);

    // Preload bookings overlapping the visible month window
    const monthStartISO = new Date(Date.UTC(y, m-1, 1, 0, 0, 0)).toISOString();
    const monthEndISO   = new Date(Date.UTC(y, m,   1, 0, 0, 0)).toISOString();
    const bookings = await getBookingsBetween(monthStartISO, monthEndISO);

    const days = {};
    const last = new Date(Date.UTC(y, m, 0, 12));
    for (let d=1; d<=last.getUTCDate(); d++){
      const key = `${y}-${pad(m)}-${pad(d)}`;
      if (key < earliestKey || key > latestKey) continue;

      const allSlots = slotsForDay(key, service_key);

      // For UI: mark each slot available/taken; still exclude anything before minStart
      const slots = allSlots
        .filter(s => new Date(s.start_iso) >= minStart)
        .map(s => {
          const taken = bookings.some(b => overlaps(s.start_iso, s.end_iso, b.start_time, b.end_time));
          return { ...s, available: !taken };
        });

      if (slots.length) days[key] = slots;
    }

    return res.json({ month, earliest_key: earliestKey, latest_key: latestKey, days });
  } catch (err) {
    console.error("[/api/availability] error", err);
    return res.status(500).json({ error: "availability_failed" });
  }
});

/* ---------- First-time check: email OR phone OR street ---------- */
router.get("/first-time", async (req, res) => {
  try {
    const email  = String(req.query.email  || "").trim().toLowerCase();
    const phone  = String(req.query.phone  || "").trim();
    const street = String(req.query.street || "").trim().toLowerCase();
    if (!email && !phone && !street) return res.json({ first_time: true });
    const seen = await hasExistingCustomer({ email, phone, street });
    return res.json({ first_time: !seen });
  } catch (e) {
    console.warn("[/api/first-time] fallback true", e?.message);
    return res.json({ first_time: true });
  }
});

export default router;
