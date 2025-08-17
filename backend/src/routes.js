import express from 'express';
import { z } from 'zod';
import { db } from './db.js';
import { SERVICES, ADDONS } from './config.js';
import { getAvailability } from './availability.js';

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

router.get('/config', (req,res)=> res.json({ services: SERVICES, addons: ADDONS }));

router.post('/availability', (req,res)=>{
  const { service_key, addons=[], fromDateISO } = req.body || {};
  try {
    const slots = getAvailability({ service_key, addons, fromDateISO });
    res.json({ slots });
  } catch (e) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

router.post('/book', (req,res)=>{
  const parsed = BookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const data = parsed.data;

  const c = db.prepare('INSERT INTO customers (name,phone,address,area,email) VALUES (?,?,?,?,?)')
    .run(data.customer.name, data.customer.phone, data.customer.address, data.area, data.customer.email||null);
  const customer_id = c.lastInsertRowid;

  const slots = data.service_key.includes('membership') ? (data.membershipSlots||[]) : [data.slot].filter(Boolean);
  if (!slots.length || (data.service_key.includes('membership') && slots.length !== 2)) {
    return res.status(400).json({ error: 'Invalid slots' });
  }

  const insert = db.prepare('INSERT INTO bookings (customer_id, service_key, addons, start_iso, end_iso, status) VALUES (?,?,?,?,?,?)');
  try {
    const tx = db.transaction(()=>{
      for(const s of slots){
        const overlap = db.prepare(`
          SELECT id FROM bookings WHERE status IN ('scheduled','started')
          AND NOT(? <= start_iso OR ? >= end_iso)
        `).all(s.start_iso, s.end_iso);
        if (overlap.length) throw new Error('Conflict');
        insert.run(customer_id, data.service_key, JSON.stringify(data.addons||[]), s.start_iso, s.end_iso, 'scheduled');
      }
    });
    tx();
  } catch {
    return res.status(409).json({ error: 'Slot conflict, please choose another time.' });
  }

  res.json({ ok:true });
});

/* minimal admin list (no auth yet; we’ll lock this later) */
router.get('/admin/bookings', (req,res)=>{
  const rows = db.prepare(`
    SELECT b.*, c.name, c.phone
    FROM bookings b
    JOIN customers c ON c.id=b.customer_id
    ORDER BY b.start_iso ASC
  `).all();
  res.json({ bookings: rows });
});
