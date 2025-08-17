import { WORKING_HOURS, BUFFER_MINUTES, SERVICES, ADDONS, MAX_DAYS_AHEAD } from './config.js';
import { db } from './db.js';
import { addMinutes, clampToWorkingWindow } from './util.js';

const overlaps = (a,b,c,d) => a < d && c < b;
const serviceDuration = (key, addons=[]) => {
  const base = SERVICES[key]?.duration || 0;
  const extra = addons.reduce((s,k)=> s + (ADDONS[k]?.extraMinutes||0), 0);
  return base + extra;
};

export function getAvailability({ service_key, addons=[], fromDateISO }) {
  const now = new Date();
  const startDate = new Date(fromDateISO || now);
  const maxDate = new Date(now.getTime() + MAX_DAYS_AHEAD*24*60*60*1000);
  const duration = serviceDuration(service_key, addons);
  const out = [];
  if (!duration) return out;

  for (let d = new Date(startDate); d <= maxDate; d = addMinutes(d, 24*60)) {
    const cfg = WORKING_HOURS[d.getDay()];
    if (!cfg) continue;
    const { start, end } = clampToWorkingWindow(d, cfg);
    const rows = db.prepare(`SELECT start_iso,end_iso FROM bookings WHERE start_iso >= ? AND start_iso < ? AND status IN ('scheduled','started')`).all(start.toISOString(), end.toISOString());
    const blocks = rows.map(r=>({ start:new Date(r.start_iso), end:new Date(r.end_iso) }));
    for (let t=new Date(start); addMinutes(t, duration) <= end; t=addMinutes(t,5)) {
      const s = new Date(t), e = addMinutes(s, duration);
      const sBuf = addMinutes(s, -BUFFER_MINUTES), eBuf = addMinutes(e, BUFFER_MINUTES);
      const conflict = blocks.some(b => overlaps(sBuf,eBuf,b.start,b.end));
      if (!conflict && s > now) out.push({ start_iso:s.toISOString(), end_iso:e.toISOString() });
    }
  }
  return out;
}
