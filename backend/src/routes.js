// backend/src/routes.js
import { Router } from "express";

const router = Router();

const TZ = "Europe/London";
const SERVICE_DURATION = {
  exterior: 75,
  full: 120,
  standard_membership: 75,
  premium_membership: 120,
};
const BUFFER_MIN = 30;
const OVERRUN_MAX_MIN = 45;

/* ---------- date helpers (DST-safe) ---------- */
const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
const toKey = (d) => {
  // yyyy-mm-dd in London local
  const s = new Date(d).toLocaleString("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [dd, mm, yyyy] = s.split("/");
  return `${yyyy}-${mm}-${dd}`;
};
const fromKeyNoonUTC = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // noon UTC (stable weekday)
};
const yyyymm = (key) => key.slice(0, 7);

/** Returns +0 or +60 (BST) minutes for that date in London */
function londonOffsetMinutes(key) {
  const dt = fromKeyNoonUTC(key);
  const hour = Number(
    dt.toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false })
  );
  return (hour - 12) * 60; // 12:00 UTC shows 13:00 in BST, 12:00 in GMT
}

/** Build a UTC Date ISO string from London local time HH:MM on a given day key */
function londonLocalToUTCISO(dayKey, hh, mm) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const offset = londonOffsetMinutes(dayKey); // +0 or +60
  const localMin = hh * 60 + mm;
  const utcMin = localMin - offset;
  const base = Date.UTC(y, m - 1, d, 0, 0, 0);
  const ts = base + utcMin * 60 * 1000;
  return new Date(ts).toISOString();
}

function isWeekend(dayKey) {
  const dow = fromKeyNoonUTC(dayKey).getUTCDay(); // 0 Sun ... 6 Sat
  return dow === 0 || dow === 6;
}

/** Parse "HH:MM" -> minutes */
function hm(str) {
  const [h, m] = str.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** Generate non-overlapping starts across the day, honoring buffer+overrun */
function generateStarts(dayKey, durationMin) {
  const wknd = isWeekend(dayKey);
  const startMin = wknd ? hm("09:00") : hm("16:00");
  const endMin = wknd ? hm("19:30") : hm("21:00");

  const res = [];
  let t = startMin;

  // Allow last job to end up to endMin + OVERRUN_MAX_MIN
  const hardEnd = endMin + OVERRUN_MAX_MIN;

  while (t + durationMin <= hardEnd) {
    // Ensure next suggested start is after buffer from this end
    res.push(t);
    // step to next candidate start
    t = t + durationMin + BUFFER_MIN;

    // If the next start would be inside the last job (rare), break
    if (t <= res[res.length - 1]) break;
    // Stop if even starting at t we cannot finish within allowed hardEnd
    if (t + durationMin > hardEnd && res.length > 0) break;
  }

  // Filter out starts that would finish past the hardEnd
  return res.filter((s) => s + durationMin <= hardEnd);
}

/** Build slots list [{start_iso,end_iso}, ...] for a given service and day */
function buildSlotsForDay(dayKey, serviceKey) {
  const duration = SERVICE_DURATION[serviceKey] ?? 75;
  const starts = generateStarts(dayKey, duration);
  return starts.map((mStart) => {
    const mEnd = mStart + duration;
    const sh = Math.floor(mStart / 60),
      sm = mStart % 60;
    const eh = Math.floor(mEnd / 60),
      em = mEnd % 60;
    return {
      start_iso: londonLocalToUTCISO(dayKey, sh, sm),
      end_iso: londonLocalToUTCISO(dayKey, eh, em),
    };
  });
}

/* ---------- GET /api/availability ---------- */
/* Query: ?service_key=exterior&month=YYYY-MM (month optional) */
router.get("/availability", (req, res) => {
  try {
    const service_key = String(req.query.service_key || "").trim() || "exterior";
    const month = String(req.query.month || "").match(/^\d{4}-\d{2}$/)
      ? String(req.query.month)
      : toKey(new Date()).slice(0, 7);

    const todayKey = toKey(new Date());
    const plus1 = new Date();
    plus1.setMonth(plus1.getMonth() + 1);
    const latestKey = toKey(plus1);

    // Build all days of requested month
    const [y, m] = month.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1, 12));
    const last = new Date(Date.UTC(y, m, 0, 12));
    const days = {};

    for (let d = 1; d <= last.getUTCDate(); d++) {
      const key = `${y}-${pad(m)}-${pad(d)}`;

      // Respect global window: today .. +1 month
      if (key < todayKey || key > latestKey) continue;

      const slots = buildSlotsForDay(key, service_key);

      // Only include days with at least one slot
      if (slots.length) {
        days[key] = slots;
      }
    }

    res.json({
      month,
      earliest_key: todayKey,
      latest_key: latestKey,
      days,
    });
  } catch (err) {
    console.error("[/api/availability] error", err);
    res.status(500).json({ error: "availability_failed" });
  }
});

export default router;
