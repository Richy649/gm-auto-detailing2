// backend/src/db.js
import pkg from "pg";
const { Pool } = pkg;

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function ensureTable() {
  // Creates table if missing (does NOT alter existing tables)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bookings (
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
    );
  `);
}

async function addColIfMissing(column, type, extra = "") {
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='bookings' AND column_name='${column}'
      ) THEN
        EXECUTE 'ALTER TABLE public.bookings ADD COLUMN ${column} ${type} ${extra}';
      END IF;
    END
    $$;
  `);
}

async function ensureColumns() {
  // Covers legacy tables missing these columns
  await addColIfMissing("stripe_session_id", "TEXT");
  await addColIfMissing("customer_email", "TEXT");
  await addColIfMissing("customer_phone", "TEXT");
  await addColIfMissing("customer_street", "TEXT");
  await addColIfMissing("customer_postcode", "TEXT");
  await addColIfMissing("has_tap", "BOOLEAN", "DEFAULT false");
}

async function ensureIndexes() {
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_time_idx
                    ON public.bookings (start_time, end_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_email_idx
                    ON public.bookings (lower(customer_email));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_phone_digits_idx
                    ON public.bookings ((regexp_replace(customer_phone,'[^0-9]+','','g')));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_street_norm_idx
                    ON public.bookings ((regexp_replace(lower(customer_street),'[^a-z0-9]+','','g')));`);
  // Optional: uniqueness helps dedupe webhook retries
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_session_idx
                    ON public.bookings (stripe_session_id);`);
}

export async function initDB() {
  if (!pool) {
    console.warn("[db] DATABASE_URL not set; DB features disabled.");
    return;
  }
  await ensureTable();
  await ensureColumns();
  await ensureIndexes();
  console.log("[db] schema ensured");
}

export async function saveBooking(b) {
  if (!pool) return null;
  const res = await pool.query(
    `INSERT INTO public.bookings
     (stripe_session_id, service_key, addons, start_time, end_time,
      customer_name, customer_email, customer_phone, customer_street, customer_postcode, has_tap)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      b.stripe_session_id || null,
      b.service_key,
      b.addons || [],
      b.start_iso,
      b.end_iso,
      b.customer?.name || null,
      (b.customer?.email || null),
      (b.customer?.phone || null),
      (b.customer?.street || null),
      (b.customer?.postcode || null),
      !!b.has_tap,
    ]
  );
  return res.rows[0]?.id || null;
}

/** Overlap query for availability masking */
export async function getBookingsBetween(startISO, endISO) {
  if (!pool) return [];
  const q = `
    SELECT id, service_key, start_time, end_time
    FROM public.bookings
    WHERE NOT (end_time <= $1 OR start_time >= $2)
  `;
  const r = await pool.query(q, [startISO, endISO]);
  return r.rows || [];
}

/** First-time client check: email OR phone OR street seen before */
export async function hasExistingCustomer({ email, phone, street }) {
  if (!pool) return false;
  try {
    const e = (email || "").toLowerCase().trim();
    const p = String(phone || "");
    const s = (street || "").toLowerCase().trim();

    const q = `
      SELECT 1
      FROM public.bookings
      WHERE
        ($1 <> '' AND lower(customer_email) = $1)
        OR
        ($2 <> '' AND regexp_replace(customer_phone,'[^0-9]+','','g') = regexp_replace($2,'[^0-9]+','','g'))
        OR
        ($3 <> '' AND regexp_replace(lower(customer_street),'[^a-z0-9]+','','g') = regexp_replace($3,'[^a-z0-9]+','','g'))
      LIMIT 1
    `;
    const r = await pool.query(q, [e, p, s]);
    return r.rowCount > 0;
  } catch (err) {
    console.warn("[db.hasExistingCustomer] error -> treating as first-time", err?.message);
    return false;
  }
}
