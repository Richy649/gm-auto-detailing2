// backend/src/db.js
import pkg from "pg";
const { Pool } = pkg;

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

export async function initDB() {
  if (!pool) {
    console.warn("[db] DATABASE_URL not set; bookings will NOT be persisted.");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      stripe_session_id TEXT,
      service_key TEXT NOT NULL,
      addons TEXT[] DEFAULT '{}',
      start_time TIMESTAMPTZ NOT NULL,
      end_time   TIMESTAMPTZ NOT NULL,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      customer_street TEXT,
      customer_postcode TEXT,
      has_tap BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log("[db] ready");
}

export async function saveBooking(b) {
  if (!pool) return null;
  const res = await pool.query(
    `INSERT INTO bookings
     (stripe_session_id, service_key, addons, start_time, end_time, customer_name, customer_email, customer_phone, customer_street, customer_postcode, has_tap)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      b.stripe_session_id || null,
      b.service_key,
      b.addons || [],
      b.start_iso,
      b.end_iso,
      b.customer?.name || null,
      b.customer?.email || null,
      b.customer?.phone || null,
      b.customer?.street || null,
      b.customer?.postcode || null,
      !!b.has_tap,
    ]
  );
  return res.rows[0]?.id || null;
}
