import pkg from "pg";
const { Pool } = pkg;

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bookings (
      id SERIAL PRIMARY KEY,
      stripe_session_id TEXT,
      service_key TEXT NOT NULL,
      addons TEXT[] DEFAULT '{}',
      start_time TIMESTAMPTZ NOT NULL,
      end_time   TIMESTAMPTZ NOT NULL,
      customer_name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function ensureColumns() {
  const addCol = async (col, type, defaultSQL = "") => {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='bookings' AND column_name='${col}'
        ) THEN
          EXECUTE 'ALTER TABLE public.bookings ADD COLUMN ${col} ${type} ${defaultSQL}';
        END IF;
      END
      $$;
    `);
  };
  await addCol("customer_email",   "TEXT");
  await addCol("customer_phone",   "TEXT");
  await addCol("customer_street",  "TEXT");
  await addCol("customer_postcode","TEXT");
  await addCol("has_tap",          "BOOLEAN", "DEFAULT false");
}

async function ensureIndexes() {
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
  console.log("[db] schema ensured (table, columns, indexes)");
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

/** true if (email OR phone OR street) has appeared in any prior booking */
export async function hasExistingCustomer({ email, phone, street }) {
  if (!pool) return false;
  try {
    // make sure columns exist before querying
    await ensureColumns();

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
