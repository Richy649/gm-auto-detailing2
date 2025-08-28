// backend/src/routes.js
import { Router } from "express";
import { hasExistingCustomer } from "./db.js";

const router = Router();

/* ---------- Basic config endpoint (prices/names) ---------- */
router.get("/config", (req, res) => {
  res.json({
    services: {
      exterior: { name: "Exterior Detail", price: 40 },
      full: { name: "Full Detail", price: 60 },
      standard_membership: { name: "Standard Membership (2 Exterior)", price: 70 },
      premium_membership: { name: "Premium Membership (2 Full)", price: 100 }
    },
    addons: {
      wax: { name: "Full Body Wax", price: 10 },
      polish: { name: "Hand Polish", price: 22.5 }
    }
  });
});

/* ---------- Availability (1 month rolling window) ---------- */
const TZ = "Europe/London";
const SERVICE_DURATION = { exterior:75, full:120, standard_membership:75, premium_membership:120 };
const BUFFER_MIN = 30;
const OVERRUN_MAX_MIN = 45;
const pad = (n)=> (n<10?`0${n}`:`${n}`);

const toKey = (d) => {
  const s = new Date(d).toLocaleString("en-GB",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
  const [dd,mm,yyyy] = s.split("/");
  return `${yyyy}-${mm}-${dd}`;
};
const fromKeyNoonUTC = (key) => { const [y,m,d]=key.split("-").map(Number); return new Date(Date.UTC(y,m-1,d,12,0,0)); };
const yyyymm = (key) => key.slice(0,7);
const hm = (str)=> { const [h,m]=str.split(":").map(Number); return h*60+(m||0); };

function londonOffsetMinutes(dayKey){
  const dt = fromKeyNoonUTC(dayKey);
  const hour = Number(dt.toLocaleString("en-GB",{timeZone:TZ,hour:"2-digit",hour12:false}));
  return (hour-12)*60;
}
function londonLocalToUTCISO(dayKey, hh, mm){
  const [y,m,d] = dayKey.split("-").map(Number);
  const offset = londonOffsetMinutes(dayKey);
  const localMin = hh*60+mm;
  const utcMin = localMin - offset;
  const base = Date.UTC(y,m-1,d,0,0,0);
  const ts = base + utcMin*60*1000;
  return new Date(ts).toISOString();
}
function isWeekend(dayKey){ const dow = fromKeyNoonUTC(dayKey).getUTCDay(); return dow===0||dow===6; }

function generateStarts(dayKey, durationMin){
  const wknd = isWeekend(dayKey);
  const startMin = wknd ? hm("09:00") : hm("16:00");
  const endMin   = wknd ? hm("19:30") : hm("21:00");
  const hardEnd = endMin + OVERRUN_MAX_MIN;
  const res=[]; let t=startMin;
  while (t + durationMin <= hardEnd){
    res.push(t);
    t = t + durationMin + BUFFER_MIN;
    if (t <= res[res.length-1]) break;
    if (t + durationMin > hardEnd && res.length>0) break;
  }
  return res.filter(s => s + durationMin <= hardEnd);
}
function buildSlotsForDay(dayKey, serviceKey){
  const duration = SERVICE_DURATION[serviceKey] ?? 75;
  const starts = generateStarts(dayKey, duration);
  return starts.map((mStart)=>{
    const mEnd = mStart + duration;
    const sh = Math.floor(mStart/60), sm = mStart%60;
    const eh = Math.floor(mEnd/60),   em = mEnd%60;
    return {
      start_iso: londonLocalToUTCISO(dayKey, sh, sm),
      end_iso:   londonLocalToUTCISO(dayKey, eh, em),
    };
  });
}

router.get("/availability", (req, res) => {
  try {
    const service_key = String(req.query.service_key || "exterior").trim();
    const monthParam = String(req.query.month || "");
    const todayKey = toKey(new Date());
    const plus1 = new Date(); plus1.setMonth(plus1.getMonth()+1);
    const latestKey = toKey(plus1);
    const month = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : yyyymm(todayKey);

    const [y,m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0, 12));
    const days = {};
    for (let d=1; d<=last.getUTCDate(); d++){
      const key = `${y}-${pad(m)}-${pad(d)}`;
      if (key < todayKey || key > latestKey) continue;
      const slots = buildSlotsForDay(key, service_key);
      if (slots.length) days[key] = slots;
    }
    res.json({ month, earliest_key: todayKey, latest_key: latestKey, days });
  } catch (err) {
    console.error("[/api/availability] error", err);
    res.status(500).json({ error: "availability_failed" });
  }
});

/* ---------- First-time check (email OR phone OR street) ---------- */
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
