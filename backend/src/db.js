// backend/src/db.js
import pkg from "pg";
const { Pool } = pkg;

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

/* ---------- helpers ---------- */
async function columnExists(table, column) {
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
    LIMIT 1`;
  const r = await pool.query(q, [table, column]);
  return r.rowCount > 0;
}

/* ---------- ensure base table ---------- */
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bookings (
      id SERIAL PRIMARY KEY,
      stripe_session_id TEXT,
      service_key TEXT,
      addons TEXT[] DEFAULT '{}',
      start_time TIMESTAMPTZ,
      end_time   TIMESTAMPTZ,
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

/* ---------- ensure columns (no DO $$, fully idempotent) ---------- */
async function ensureColumns() {
  // Columns we rely on
  if (!(await columnExists("bookings", "stripe_session_id")))
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN stripe_session_id TEXT;`);

  if (!(await columnExists("bookings", "service_key")))
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN service_key TEXT;`);

  if (!(await columnExists("bookings", "addons"))) {
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN addons TEXT[];`);
    await pool.query(`ALTER TABLE public.bookings ALTER COLUMN addons SET DEFAULT '{}'::text[];`);
  }

  // Time columns: add & backfill from legacy start_iso / end_iso if those exist
  const hasStartTime = await columnExists("bookings", "start_time");
  const hasEndTime   = await columnExists("bookings", "end_time");
  const hasStartIso  = await columnExists("bookings", "start_iso");
  const hasEndIso    = await columnExists("bookings", "end_iso");

  if (!hasStartTime) {
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN start_time TIMESTAMPTZ;`);
    if (hasStartIso) {
      // best-effort backfill
      await pool.query(`UPDATE public.bookings SET start_time = NULLIF(start_iso,'')::timestamptz;`).catch(()=>{});
    }
  }
  if (!hasEndTime) {
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN end_time TIMESTAMPTZ;`);
    if (hasEndIso) {
      await pool.query(`UPDATE public.bookings SET end_time = NULLIF(end_iso,'')::timestamptz;`).catch(()=>{});
    }
  }

  if (!(await columnExists("bookings", "customer_name")))
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN customer_name TEXT;`);

  if (!(await columnExists("bookings", "customer_email")))
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN customer_email TEXT;`);

  if (!(await columnExists("bookings", "customer_phone")))
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN customer_phone TEXT;`);

  if (!(await columnExists("bookings", "customer_street")))
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN customer_street TEXT;`);

  if (!(await columnExists("bookings", "customer_postcode")))
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN customer_postcode TEXT;`);

  if (!(await columnExists("bookings", "has_tap")))
    await pool.query(`ALTER TABLE public.bookings ADD COLUMN has_tap BOOLEAN DEFAULT false;`);
}

/* ---------- ensure indexes (only when columns exist) ---------- */
async function ensureIndexes() {
  // time index only if both columns exist
  if (await columnExists("bookings", "start_time") && await columnExists("bookings", "end_time")) {
    await pool.query(`CREATE INDEX IF NOT EXISTS bookings_time_idx ON public.bookings (start_time, end_time);`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_email_idx
                    ON public.bookings (lower(customer_email));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_phone_digits_idx
                    ON public.bookings ((regexp_replace(customer_phone,'[^0-9]+','','g')));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_street_norm_idx
                    ON public.bookings ((regexp_replace(lower(customer_street),'[^a-z0-9]+','','g')));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_session_idx
                    ON public.bookings (stripe_session_id);`);
}

/* ---------- public API ---------- */
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
      b.service_key || null,
      b.addons || [],
      b.start_iso || null,
      b.end_iso || null,
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

/** returns bookings overlapping [startISO, endISO) */
export async function getBookingsBetween(startISO, endISO) {
  if (!pool) return [];
  const q = `
    SELECT id, service_key, start_time, end_time
    FROM public.bookings
    WHERE start_time IS NOT NULL AND end_time IS NOT NULL
      AND NOT (end_time <= $1 OR start_time >= $2)
  `;
  const r = await pool.query(q, [startISO, endISO]);
  return r.rows || [];
}

/** (email OR phone OR street) seen before */
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
