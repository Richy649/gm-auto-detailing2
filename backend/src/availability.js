import { WORKING_HOURS, BUFFER_MINUTES, SERVICES, ADDONS, MAX_DAYS_AHEAD } from './config.js';
import { db } from './db.js';

const MS = 60 * 1000;
const addMin = (d, m) => new Date(d.getTime() + m * MS);
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

function parseHHMM(str) {
  const [h, m] = (str || '00:00').split(':').map(n => parseInt(n, 10));
  return { h: h || 0, m: m || 0 };
}
function dayWindow(date, cfg) {
  const { h: sh, m: sm } = parseHHMM(cfg?.start);
  const { h: eh, m: em } = parseHHMM(cfg?.end);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), sh, sm, 0, 0);
  const end   = new Date(date.getFullYear(), date.getMonth(), date.getDate(), eh, em, 0, 0);
  return { start, end };
}
function serviceDuration(service_key, addons=[]) {
  const base = SERVICES[service_key]?.duration || 0;
  const extra = addons.reduce((s,k)=> s + (ADDONS[k]?.extraMinutes || 0), 0);
  return base + extra;
}

/**
 * LIVE availability generator (source of truth)
 * - local timezone (set TZ=Europe/London in env)
 * - 24h minimum notice
 * - 30 days ahead max (MAX_DAYS_AHEAD)
 * - filters days by allowedDows if provided
 * - excludes existing DB bookings + buffer
 */
export function getAvailability({ service_key, addons = [], fromDateISO, allowedDows }) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const windowStart = fromDateISO ? new Date(fromDateISO) : startOfToday;
  const windowEnd = new Date(startOfToday.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000);
  const cutoffMin = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h rule
  const duration = serviceDuration(service_key, addons);
  const out = [];
  if (!duration) return out;

  for (let d = new Date(windowStart); d <= windowEnd; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const dow = d.getDay(); // 0=Sun..6=Sat
    if (allowedDows && !allowedDows.has(dow)) continue;

    const cfg = WORKING_HOURS[dow];
    if (!cfg) continue;
    const { start: dayStart, end: dayEnd } = dayWindow(d, cfg);
    if (dayEnd <= dayStart) continue;

    // Get all bookings overlapping this day window
    const rows = db.prepare(`
      SELECT start_iso, end_iso
      FROM bookings
      WHERE NOT (? <= start_iso OR ? >= end_iso)
    `).all(dayStart.toISOString(), dayEnd.toISOString());
    const busy = rows.map(r => ({ start: new Date(r.start_iso), end: new Date(r.end_iso) }));

    // Generate candidate slots every 5 minutes
    for (let s = new Date(dayStart); addMin(s, duration) <= dayEnd; s = addMin(s, 5)) {
      if (s < cutoffMin) continue;               // 24h minimum
      const e = addMin(s, duration);
      const sBuf = addMin(s, -BUFFER_MINUTES);
      const eBuf = addMin(e,  BUFFER_MINUTES);

      const clash = busy.some(b => overlaps(sBuf, eBuf, b.start, b.end));
      if (!clash) out.push({ start_iso: s.toISOString(), end_iso: e.toISOString() });
    }
  }

  return out;
}
