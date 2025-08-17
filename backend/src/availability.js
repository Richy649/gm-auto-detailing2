import { WORKING_HOURS, BUFFER_MINUTES, SERVICES, ADDONS, MAX_DAYS_AHEAD } from './config.js';
import { db } from './db.js';
import { addMinutes, clampToWorkingWindow } from './util.js';
import { getGCalBusy } from './gcal.js';

const overlaps = (a,b,c,d) => a < d && c < b;
const serviceDuration = (key, addons=[]) => {
  const base = SERVICES[key]?.duration || 0;
  const extra = addons.reduce((s,k)=> s + (ADDONS[k]?.extraMinutes||0), 0);
  return base + extra;
};

/**
 * Compute available slots, excluding:
 *  - your DB bookings
 *  - Google Calendar events (if configured)
 *  - days not allowed by 'allowedDows' (Set of 0..6)
 */
export async function getAvailability({ service_key, addons = [], fromDateISO, allowedDows }) {
  const now = new Date();
  const startDate = new Date(fromDateISO || now);
  const maxDate = new Date(now.getTime() + MAX_DAYS_AHEAD*24*60*60*1000);
  const duration = serviceDuration(service_key, addons);
  const out = [];
  if (!duration) return out;

  // Pull GCal busy blocks once for the whole window
  const gcalBusy = await getGCalBusy(
    new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0).toISOString(),
    new Date(maxDate.getFullYear(),   maxDate.getMonth(),   maxDate.getDate()+1, 0, 0, 0).toISOString()
  );

  for (let d = new Date(startDate); d <= maxDate; d = addMinutes(d, 24*60)) {
    const dow = d.getDay(); // 0=Sun...6=Sat
    if (allowedDows && !allowedDows.has(dow)) continue;

    const cfg = WORKING_HOURS[dow];
    if (!cfg) continue;

    const { start, end } = clampToWorkingWindow(d, cfg);

    // DB busy blocks for this day
    const rows = db.prepare(`
      SELECT start_iso,end_iso
      FROM bookings
      WHERE start_iso >= ? AND start_iso < ?
        AND status IN ('scheduled','started')
    `).all(start.toISOString(), end.toISOString());
    const dbBlocks = rows.map(r=>({ start:new Date(r.start_iso), end:new Date(r.end_iso) }));

    // Merge DB + GCal blocks for conflict checks
    const blocks = dbBlocks.concat(gcalBusy);

    for (let t=new Date(start); addMinutes(t, duration) <= end; t=addMinutes(t,5)) {
      const s = new Date(t), e = addMinutes(s, duration);
      const sBuf = addMinutes(s, -BUFFER_MINUTES);
      const eBuf = addMinutes(e,  BUFFER_MINUTES);
      const conflict = blocks.some(b => overlaps(sBuf,eBuf,b.start,b.end));
      if (!conflict && s > now) out.push({ start_iso:s.toISOString(), end_iso:e.toISOString() });
    }
  }
  return out;
}
