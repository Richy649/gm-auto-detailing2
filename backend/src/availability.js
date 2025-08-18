// backend/src/availability.js
import { DateTime, Interval } from "luxon";
import { getConfig } from "./config.js";

const TZ = "Europe/London";

/* NO GOOGLE CALENDAR: busy list is empty */
async function listBusyIntervals(_startISO, _endISO) { return []; }

function isWeekend(dt) { const w = dt.setZone(TZ).weekday; return w === 6 || w === 7; }
function familiesFor(durationMin, dt, fam) {
  if (isWeekend(dt)) return durationMin === 120 ? fam.weekend_120 : fam.weekend_75;
  return durationMin === 120 ? fam.weekday_120 : fam.weekday_75;
}
function makeSlotISO(dtDay, hm, durationMin) {
  const [H, M] = hm.split(":").map(Number);
  const start = dtDay.set({ hour: H, minute: M, second: 0, millisecond: 0 }).setZone(TZ, { keepLocalTime: true });
  const end = start.plus({ minutes: durationMin });
  return { start_iso: start.toUTC().toISO(), end_iso: end.toUTC().toISO() };
}
function removeClashes(candidates, busy) {
  if (!busy?.length) return candidates;
  const busyIntervals = busy.map(b => Interval.fromDateTimes(DateTime.fromISO(b.start), DateTime.fromISO(b.end)));
  return candidates.filter(s => {
    const a = Interval.fromDateTimes(DateTime.fromISO(s.start_iso), DateTime.fromISO(s.end_iso));
    return !busyIntervals.some(b => a.overlaps(b));
  });
}

export async function getAvailability(req, res) {
  try {
    const cfg = getConfig();
    const { service_key, month, lead_minutes } = req.query || {};
    const svc = cfg.services?.[service_key];
    if (!svc) return res.status(400).json({ ok: false, error: "Unknown service_key" });

    const durationMin = svc.visitService ? (cfg.services[svc.visitService]?.duration || svc.duration) : (svc.duration || 0);
    const monthStart = month
      ? DateTime.fromISO(month + "-01", { zone: TZ })
      : DateTime.now().setZone(TZ).startOf("month");
    const monthEnd = monthStart.endOf("month");

    const lead = Number.isFinite(+lead_minutes) ? +lead_minutes : (cfg.lead_minutes || 1440);
    const leadCutoff = DateTime.now().setZone(TZ).plus({ minutes: lead });

    let candidates = [];
    for (let d = monthStart; d <= monthEnd; d = d.plus({ days: 1 })) {
      const starts = familiesFor(durationMin, d, cfg.families);
      for (const hm of starts) {
        const slot = makeSlotISO(d, hm, durationMin);
        if (DateTime.fromISO(slot.start_iso) >= leadCutoff.toUTC()) candidates.push(slot);
      }
    }

    const busy = await listBusyIntervals(monthStart.toUTC().toISO(), monthEnd.toUTC().toISO()); // []
    const free = removeClashes(candidates, busy);

    const byDay = {};
    for (const s of free) {
      const dt = DateTime.fromISO(s.start_iso).setZone(TZ);
      const key = dt.toFormat("yyyy-LL-dd");
      (byDay[key] ||= []).push(s);
    }
    for (const k of Object.keys(byDay)) {
      byDay[k].sort((a,b)=> DateTime.fromISO(a.start_iso) - DateTime.fromISO(b.start_iso));
    }

    const keys = Object.keys(byDay).sort();
    res.json({ ok: true, days: byDay, earliest_key: keys[0] || null, latest_key: keys[keys.length - 1] || null });
  } catch (e) {
    console.error("[getAvailability] error", e);
    res.status(500).json({ ok: false, error: "Failed to build availability" });
  }
}

/* Used by payments revalidation; with no calendar, everything is free */
export async function isSlotFree(_service_key, _startISO, _endISO) {
  return true;
}
