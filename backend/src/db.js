// backend/src/db.js
import pkg from "pg";
const { Pool } = pkg;

/**
 * Pool
 */
export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

/* ----------------------------- helpers ----------------------------- */
async function tableExists(schema, table) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2 LIMIT 1`,
    [schema, table]
  );
  return r.rowCount > 0;
}

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

/* ----------------------------- schema ensure ----------------------------- */
/**
 * Create all tables we use, if missing.
 */
async function ensureTables() {
  // users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      name TEXT,
      phone TEXT,
      street TEXT,
      postcode TEXT,
      stripe_customer_id TEXT,
      membership_intro_used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // bookings
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bookings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      stripe_session_id TEXT,
      service_key TEXT,
      addons TEXT[] DEFAULT '{}'::text[],
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

  // subscriptions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      stripe_subscription_id TEXT UNIQUE NOT NULL,
      tier TEXT NOT NULL,
      status TEXT NOT NULL,
      current_period_start TIMESTAMPTZ,
      current_period_end   TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // credit_ledger
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.credit_ledger (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      service_type TEXT NOT NULL,          -- 'exterior' | 'full'
      qty INTEGER NOT NULL,                -- +2 grant, -1 debit, etc.
      kind TEXT NOT NULL,                  -- 'grant' | 'debit' | 'adjust'
      reason TEXT,
      related_booking_id INTEGER,
      stripe_invoice_id TEXT,
      valid_from TIMESTAMPTZ,
      valid_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

/**
 * Make sure columns exist and are nullable where needed (migrate older schemas).
 */
async function ensureColumnsAndConstraints() {
  /* ---------- users ---------- */
  const usersNeeded = [
    ["email", "TEXT", "UNIQUE"],
    ["password_hash", "TEXT", ""],
    ["name", "TEXT", ""],
    ["phone", "TEXT", ""],
    ["street", "TEXT", ""],
    ["postcode", "TEXT", ""],
    ["stripe_customer_id", "TEXT", ""],
    ["membership_intro_used", "BOOLEAN", "DEFAULT FALSE"],
    ["created_at", "TIMESTAMPTZ", "DEFAULT now()"],
    ["updated_at", "TIMESTAMPTZ", "DEFAULT now()"],
  ];
  for (const [col, type, extra] of usersNeeded) {
    if (!(await columnExists("users", col))) {
      await pool.query(`ALTER TABLE public.users ADD COLUMN ${col} ${type} ${extra};`);
    }
  }

  try {
    if (await isNotNull("users", "email")) {
      await pool.query(`ALTER TABLE public.users ALTER COLUMN email DROP NOT NULL;`);
    }
  } catch {}

  /* ---------- bookings ---------- */
  const bookingsNeeded = [
    ["user_id", "INTEGER", ""],
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
    ["created_at", "TIMESTAMPTZ", "DEFAULT now()"],
  ];
  for (const [col, type, extra] of bookingsNeeded) {
    if (!(await columnExists("bookings", col))) {
      await pool.query(`ALTER TABLE public.bookings ADD COLUMN ${col} ${type} ${extra};`);
    }
  }

  // Make sure legacy text fields are nullable (some old schemas set NOT NULL)
  try {
    if (await isNotNull("bookings", "start_iso")) {
      await pool.query(`ALTER TABLE public.bookings ALTER COLUMN start_iso DROP NOT NULL;`);
    }
    if (await isNotNull("bookings", "end_iso")) {
      await pool.query(`ALTER TABLE public.bookings ALTER COLUMN end_iso DROP NOT NULL;`);
    }
  } catch {}

  // Safer one-time backfill canonical timestamptz from legacy strings where missing.
  // Only cast ISO-looking strings; skip blanks/invalids to avoid errors.
  await pool
    .query(`
      UPDATE public.bookings
      SET start_time = start_iso::timestamptz
      WHERE start_time IS NULL
        AND start_iso IS NOT NULL
        AND btrim(start_iso) <> ''
        AND start_iso ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T';
    `)
    .catch(() => {});

  await pool
    .query(`
      UPDATE public.bookings
      SET end_time = end_iso::timestamptz
      WHERE end_time IS NULL
        AND end_iso IS NOT NULL
        AND btrim(end_iso) <> ''
        AND end_iso ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T';
    `)
    .catch(() => {});
}

/**
 * Indexes used by queries. All are conditional (IF NOT EXISTS) and reference only existing cols.
 */
async function ensureIndexes() {
  // users
  await pool.query(`CREATE INDEX IF NOT EXISTS users_email_lower_idx ON public.users (lower(email));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_phone_digits_idx ON public.users ((regexp_replace(phone,'[^0-9]+','','g')));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_street_norm_idx ON public.users ((regexp_replace(lower(street),'[^a-z0-9]+','','g')));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_stripe_customer_id_idx ON public.users (stripe_customer_id);`);

  // bookings
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_time_idx ON public.bookings (start_time, end_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_session_idx ON public.bookings (stripe_session_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_email_idx ON public.bookings (lower(customer_email));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_phone_digits_idx ON public.bookings ((regexp_replace(customer_phone,'[^0-9]+','','g')));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_street_norm_idx ON public.bookings ((regexp_replace(lower(customer_street),'[^a-z0-9]+','','g')));`);

  // subscriptions
  await pool.query(`CREATE INDEX IF NOT EXISTS subs_user_idx ON public.subscriptions (user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS subs_status_idx ON public.subscriptions (status);`);

  // credit_ledger
  await pool.query(`CREATE INDEX IF NOT EXISTS credit_user_service_idx ON public.credit_ledger (user_id, service_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS credit_invoice_idx ON public.credit_ledger (stripe_invoice_id);`);
}

/**
 * Public init
 */
export async function initDB() {
  if (!pool) {
    console.warn("[db] DATABASE_URL not set; DB features disabled.");
    return;
  }

  // Create all tables if missing
  await ensureTables();

  // Patch columns / constraints
  await ensureColumnsAndConstraints();

  // Indexes
  await ensureIndexes();

  console.log("[db] schema ensured");
}

/* ----------------------------- writes & reads ----------------------------- */
/**
 * Save a booking row.
 * Params:
 *   - b.user_id (optional, Integer)
 *   - b.stripe_session_id
 *   - b.service_key
 *   - b.addons (Text[])
 *   - b.start_iso / b.end_iso (prefer ISO strings)
 *   - b.customer { name,email,phone,street,postcode }
 *   - b.has_tap (Boolean)
 */
export async function saveBooking(b) {
  if (!pool) {
    console.warn("[db] saveBooking skipped: no pool (DATABASE_URL missing)");
    return null;
  }

  // Prefer ISO strings; if caller provided explicit timestamptz, fall back to those.
  const startISO = b.start_iso || b.start_time || null;
  const endISO   = b.end_iso   || b.end_time   || null;

  const sql = `
    INSERT INTO public.bookings
      (user_id,
       stripe_session_id, service_key, addons,
       start_iso, end_iso,
       start_time, end_time,
       customer_name, customer_email, customer_phone, customer_street, customer_postcode, has_tap)
    VALUES
      ($1,
       $2,$3,$4,
       $5,$6,
       $7,$8,
       $9,$10,$11,$12,$13,$14)
    RETURNING id
  `;
  const params = [
    b.user_id || null,                     // $1 user_id
    b.stripe_session_id || null,           // $2
    b.service_key || null,                 // $3
    b.addons || [],                        // $4
    startISO,                              // $5 -> start_iso (TEXT)
    endISO,                                // $6 -> end_iso (TEXT)
    startISO,                              // $7 -> start_time (TIMESTAMPTZ via implicit cast)
    endISO,                                // $8 -> end_time   (TIMESTAMPTZ via implicit cast)
    b.customer?.name || null,              // $9
    (b.customer?.email || null),           // $10
    (b.customer?.phone || null),           // $11
    (b.customer?.street || null),          // $12
    (b.customer?.postcode || null),        // $13
    !!b.has_tap,                           // $14
  ];

  const res = await pool.query(sql, params);
  const id = res.rows[0]?.id || null;
  console.log(`[saveBooking] inserted id=${id} user_id=${b.user_id || "-"} service=${b.service_key} start=${startISO} end=${endISO}`);
  return id;
}

/** availability masking: get rows overlapping [startISO, endISO) using canonical timestamptz */
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

/** first-time: seen by email OR phone OR street (bookings history only) */
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
