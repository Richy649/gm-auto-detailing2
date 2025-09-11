// backend/src/db.js
import pkg from "pg";
const { Pool } = pkg;

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

/* ---------- helpers ---------- */
async function columnExists(table, column) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, column]
  );
  return r.rowCount > 0;
}
async function isNotNull(table, column) {
  const r = await pool.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return r.rows[0]?.is_nullable === "NO";
}

/* ---------- bootstrap schema ---------- */
async function ensureTables() {
  // users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      street TEXT,
      postcode TEXT,
      has_tap BOOLEAN DEFAULT FALSE,
      stripe_customer_id TEXT,
      membership_intro_used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // password reset tokens
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.password_resets (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // bookings
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bookings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES public.users(id),
      stripe_session_id TEXT,
      service_key TEXT,
      addons TEXT[] DEFAULT '{}',
      -- legacy string fields (kept for back-compat)
      start_iso TEXT,
      end_iso   TEXT,
      -- canonical timestamptz fields used by availability
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

  // credit ledger
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.credit_ledger (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      service_type TEXT NOT NULL CHECK (service_type IN ('exterior','full')),
      qty INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('grant','debit','adjust')),
      reason TEXT,
      related_booking_id INTEGER,
      stripe_invoice_id TEXT,
      valid_from TIMESTAMPTZ,
      valid_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // subscriptions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      stripe_subscription_id TEXT UNIQUE NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('standard','premium')),
      status TEXT NOT NULL,
      current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function ensureColumnsAndConstraints() {
  // Ensure all expected columns on bookings exist and legacy constraints are sane
  const need = [
    ["user_id", "INTEGER", "REFERENCES public.users(id)"],
    ["stripe_session_id", "TEXT", ""],
    ["service_key", "TEXT", ""],
    ["addons", "TEXT[]", "DEFAULT '{}'::text[]"],
    ["start_iso", "TEXT", ""],
    ["end_iso", "TEXT", ""],
    ["start_time", "TIMESTAMPTZ", ""],
    ["end_time", "TIMESTAMPTZ", ""],
    ["customer_name", "TEXT", ""],
    ["customer_email", "TEXT", ""],
    ["customer_phone", "TEXT", ""],
    ["customer_street", "TEXT", ""],
    ["customer_postcode", "TEXT", ""],
    ["has_tap", "BOOLEAN", "DEFAULT false"],
  ];
  for (const [col, type, extra] of need) {
    if (!(await columnExists("bookings", col))) {
      await pool.query(`ALTER TABLE public.bookings ADD COLUMN ${col} ${type} ${extra};`);
    }
  }

  // Make sure legacy text fields are nullable
  if (await isNotNull("bookings", "start_iso")) {
    await pool.query(`ALTER TABLE public.bookings ALTER COLUMN start_iso DROP NOT NULL;`);
  }
  if (await isNotNull("bookings", "end_iso")) {
    await pool.query(`ALTER TABLE public.bookings ALTER COLUMN end_iso DROP NOT NULL;`);
  }

  // Backfill canonical timestamptz from legacy strings where missing
  await pool
    .query(`UPDATE public.bookings
            SET start_time = COALESCE(start_time, NULLIF(start_iso,'')::timestamptz),
                end_time   = COALESCE(end_time,   NULLIF(end_iso,'')::timestamptz)
            WHERE (start_time IS NULL OR end_time IS NULL);`)
    .catch(() => {});
}

async function ensureIndexes() {
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_time_idx
                    ON public.bookings (start_time, end_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_session_idx
                    ON public.bookings (stripe_session_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_email_idx
                    ON public.bookings (lower(customer_email));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_phone_digits_idx
                    ON public.bookings ((regexp_replace(customer_phone,'[^0-9]+','','g')));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_street_norm_idx
                    ON public.bookings ((regexp_replace(lower(customer_street),'[^a-z0-9]+','','g')));`);

  await pool.query(`CREATE INDEX IF NOT EXISTS users_email_idx ON public.users (lower(email));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ledger_user_idx ON public.credit_ledger (user_id, service_type, created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS subs_stripe_idx ON public.subscriptions (stripe_subscription_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pwres_email_idx ON public.password_resets (lower(email));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pwres_token_idx ON public.password_resets (token);`);
}

export async function initDB() {
  if (!pool) {
    console.warn("[db] DATABASE_URL not set; DB features disabled.");
    return;
  }
  await ensureTables();
  await ensureColumnsAndConstraints();
  await ensureIndexes();
  console.log("[db] schema ensured");
}

/* ---------- writes & reads ---------- */
export async function saveBooking(b) {
  if (!pool) {
    console.warn("[db] saveBooking skipped: no pool (DATABASE_URL missing)");
    return null;
  }

  const startISO = b.start_iso || b.start_time || null;
  const endISO   = b.end_iso   || b.end_time   || null;

  const sql = `
    INSERT INTO public.bookings
      (user_id, stripe_session_id, service_key, addons,
       start_iso, end_iso,
       start_time, end_time,
       customer_name, customer_email, customer_phone, customer_street, customer_postcode, has_tap)
    VALUES
      ($1,$2,$3,$4,
       $5,$6,
       $7,$8,
       $9,$10,$11,$12,$13,$14)
    RETURNING id
  `;
  const params = [
    b.user_id || null,
    b.stripe_session_id || null,
    b.service_key || null,
    b.addons || [],
    startISO,
    endISO,
    startISO,
    endISO,
    b.customer?.name || null,
    (b.customer?.email || null),
    (b.customer?.phone || null),
    (b.customer?.street || null),
    (b.customer?.postcode || null),
    !!b.has_tap,
  ];

  const res = await pool.query(sql, params);
  const id = res.rows[0]?.id || null;
  console.log(`[saveBooking] inserted id=${id} service=${b.service_key} start=${startISO} end=${endISO} user_id=${b.user_id ?? "null"}`);
  return id;
}

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

/** first-time: seen by email OR phone OR street */
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

/* (optional) for admin endpoint */
export async function listRecentBookings(limit = 10) {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT id, service_key, start_time, end_time, customer_name, customer_email, created_at
     FROM public.bookings
     ORDER BY id DESC LIMIT $1`,
    [Math.max(1, Math.min(100, Number(limit) || 10))]
  );
  return r.rows || [];
}
