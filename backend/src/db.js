// backend/src/db.js
import pkg from "pg";
const { Pool } = pkg;

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

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

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bookings (
      id SERIAL PRIMARY KEY,
      stripe_session_id TEXT,
      service_key TEXT,
      addons TEXT[] DEFAULT '{}',
      /* legacy text columns kept for backward compat */
      start_iso TEXT,
      end_iso   TEXT,
      /* canonical timestamptz */
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

async function ensureColumns() {
  // Make sure all needed columns exist
  const needCols = [
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
  for (const [col, type, extra] of needCols) {
    if (!(await columnExists("bookings", col))) {
      await pool.query(`ALTER TABLE public.bookings ADD COLUMN ${col} ${type} ${extra};`);
    }
  }

  // Drop NOT NULL on legacy text columns if present
  if (await isNotNull("bookings", "start_iso")) {
    await pool.query(`ALTER TABLE public.bookings ALTER COLUMN start_iso DROP NOT NULL;`);
  }
  if (await isNotNull("bookings", "end_iso")) {
    await pool.query(`ALTER TABLE public.bookings ALTER COLUMN end_iso DROP NOT NULL;`);
  }

  // Backfill canonical timestamptz from legacy text if missing
  await pool
    .query(`UPDATE public.bookings
            SET start_time = NULLIF(start_iso,'')::timestamptz
            WHERE start_time IS NULL AND start_iso IS NOT NULL;`)
    .catch(() => {});
  await pool
    .query(`UPDATE public.bookings
            SET end_time = NULLIF(end_iso,'')::timestamptz
            WHERE end_time IS NULL AND end_iso IS NOT NULL;`)
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

/** Always writes both legacy text and canonical timestamptz fields */
export async function saveBooking(b) {
  if (!pool) return null;
  const startISO = b.start_iso || null;
  const endISO   = b.end_iso   || null;

  const res = await pool.query(
    `INSERT INTO public.bookings
     (stripe_session_id, service_key, addons,
      start_iso, end_iso, start_time, end_time,
      customer_name, customer_email, customer_phone, customer_street, customer_postcode, has_tap)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      b.stripe_session_id || null,
      b.service_key || null,
      b.addons || [],
      startISO,
      endISO,
      startISO ? null : b.start_time || null, // prefer explicit fields if provided
      endISO   ? null : b.end_time   || null,
      b.customer?.name || null,
      (b.customer?.email || null),
      (b.customer?.phone || null),
      (b.customer?.street || null),
      (b.customer?.postcode || null),
      !!b.has_tap,
    ]
  );
  // Also, if we only had ISO strings, backfill timestamptz in the same row
  const id = res.rows[0]?.id;
  if (id && (startISO || endISO)) {
    await pool
      .query(
        `UPDATE public.bookings
         SET start_time = COALESCE(start_time, NULLIF(start_iso,'')::timestamptz),
             end_time   = COALESCE(end_time,   NULLIF(end_iso,'')::timestamptz)
         WHERE id = $1`,
        [id]
      )
      .catch(() => {});
  }
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
