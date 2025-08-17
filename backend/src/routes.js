import express from 'express';
import { z } from 'zod';
import { db } from './db.js';
import { SERVICES, ADDONS, MAX_DAYS_AHEAD } from './config.js';

export const router = express.Router();

const CustomerSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(6),
  address: z.string().min(5),
  email: z.string().email().optional().or(z.literal(''))
});
const BookingSchema = z.object({
  customer: CustomerSchema,
  area: z.enum(['left','right']).default('right'),
  service_key: z.enum(['exterior','full','standard_membership','premium_membership']),
  addons: z.array(z.enum(['wax','polish'])).default([]),
  slot: z.object({ start_iso: z.string(), end_iso: z.string() }).optional(),
  membershipSlots: z.array(z.object({ start_iso: z.string(), end_iso: z.string() })).optional()
});

// Config endpoint
router.get('/config', (req, res) => res.json({ services: SERVICES, addons: ADDONS }));

// Simple debug
router.get('/debug/time', (req, res) => {
  res.json({ now: new Date().toISOString(), tz: process.env.TZ || 'unset' });
});

/** ---- FORCE SLOTS: guaranteed times so the UI lights up ----
 * Right of Sheen => Mon, Wed, Fri, Sun (1,3,5,0)
 * Left  of Sheen => Tue, Thu, Sat       (2,4,6)
 * 24h minimum notice, up to MAX_DAYS_AHEAD.
 * Fixed times each allowed day: 10:00, 13:00, 16:00
 */
function forcedSlots(service_key, area='right') {
  const allowed = new Set(area === 'left' ? [2,4,6] : [1,3,5,0]); // 0=Sun..6=Sat
  const out = [];
  const now = new Date();
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1); // 24h min (day-level)
  const endDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + MAX_DAYS_AHEAD);
  const durMin = SERVICES[service_key]?.duration || 60;
  const times = ['10:00','13:00','16:00'];

  for (let d = new Date(startDay); d <= endDay; d.setDate(d.getDate() + 1)) {
    if (!allowed.has(d.getDay())) continue;
    for (const hhmm of times) {
      const [h,m] = hhmm.split(':').map(Number);
      const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
      const e = new Date(s.getTime() + durMin*60*1000);
      out.push({ start_iso: s.toISOString(), end_iso: e.toISOString() });
    }
  }
  return out;
}

// Availability: ALWAYS return forced slots for now
router.post('/availability', (req, res) => {
  const { service_key, area = 'right' } = req.body || {};
  if (!service_key || !(service_key in SERVICES)) {
    return res.json({ slots: [] });
  }
  const slots = forcedSlots(service_key, area);
  return res.json({ slots });
});

// Book (kept the same)
router.post('/book', (req, res) => {
  const parsed = BookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const data = parsed.data;

  const c = db.prepare('INSERT INTO customers (name,phone,address,area,email) VALUES (?,?,?,?,?)')
    .run(data.customer.name, data.customer.phone, data.customer.address, data.area, data.customer.email || null);
  const customer_id = c.lastInsertRowid;

  const isMembership = data.service_key.includes('membership');
  const slots = isMembership ? (data.membershipSlots || []) : [data.slot].filter(Boolean);
  if (!slots.length || (isMembership && slots.length !== 2)) {
    return res.status(400).json({ error: 'Invalid slots' });
  }
  if (isMembership) {
    const dayKey = iso => new Date(iso).toISOString().slice(0,10);
    if (dayKey(slots[0].start_iso) === dayKey(slots[1].start_iso)) {
      return res.status(400).json({ error: 'Membership visits must be on two different days.' });
    }
  }

  const insert = db.prepare('INSERT INTO bookings (customer_id, service_key, addons, start_iso, end_iso, status) VALUES (?,?,?,?,?,?)');
  try {
    const tx = db.transaction(()=>{
      for(const s of slots){
        const overlap = db.prepare(`
          SELECT id FROM bookings
          WHERE status IN ('scheduled','started')
          AND NOT(? <= start_iso OR ? >= end_iso)
        `).all(s.start_iso, s.end_iso);
        if (overlap.length) throw new Error('Conflict');
        insert.run(customer_id, data.service_key, JSON.stringify(data.addons || []), s.start_iso, s.end_iso, 'scheduled');
      }
    });
    tx();
  } catch {
    return res.status(409).json({ error: 'Slot conflict, please choose another time.' });
  }

  res.json({ ok:true });
});
