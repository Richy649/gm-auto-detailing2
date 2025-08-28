import { Router } from "express";
import { hasExistingCustomer } from "./db.js";

const router = Router();

/* ---------- Config (names / prices) ---------- */
router.get("/config", (_req, res) => {
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

/* ---------- Availability (rolling 1 month forward) ---------- */
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
  return (hour - 12) * 60; // relative to UTC noon anchor
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

function generateStarts(dayKey, durationMin){
  const wknd = isWeekend(dayKey);
  const startMin = wknd ? hm("09:00") : hm("16:00");
  const endMin   = wknd ? hm("19:30") : hm("21:00");
  const hardEnd = endMin + OVERRUN_MAX_MIN;

  const res=[]; let t=startMin;
  while (t + durationMin <= hardEnd){
    res.push(t);
    const next = t + durationMin + BUFFER_MIN;
    if (next <= t) break;
    t = next;
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

router.get("/availability", (req, res) => {
  try {
    const service_key = String(req.query.service_key || "exterior").trim();
    const monthParam  = String(req.query.month || "").trim();

    const todayKey = toKey(new Date());
    const plus1 = new Date(); plus1.setMonth(plus1.getMonth()+1);
    const latestKey = toKey(plus1);

    const month = /^\d{4}-\d{2}$/.test(monthParam)
      ? monthParam
      : monthOfKey(todayKey);

    const [y,m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0, 12));
    const days = {};
    for (let d=1; d<=last.getUTCDate(); d++){
      const key = `${y}-${pad(m)}-${pad(d)}`;
      if (key < todayKey || key > latestKey) continue;
      const slots = slotsForDay(key, service_key);
      if (slots.length) days[key] = slots;
    }
    return res.json({ month, earliest_key: todayKey, latest_key: latestKey, days });
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
