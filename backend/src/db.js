import pkg from "pg";
const { Pool } = pkg;

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
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
    );
    -- Helpful indexes for identity lookups
    CREATE INDEX IF NOT EXISTS bookings_email_idx ON bookings (lower(customer_email));
    CREATE INDEX IF NOT EXISTS bookings_phone_digits_idx ON bookings ((regexp_replace(customer_phone,'[^0-9]+','','g')));
    CREATE INDEX IF NOT EXISTS bookings_street_norm_idx ON bookings ((regexp_replace(lower(customer_street),'[^a-z0-9]+','','g')));
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
      (b.customer?.email || null),
      (b.customer?.phone || null),
      (b.customer?.street || null),
      (b.customer?.postcode || null),
      !!b.has_tap,
    ]
  );
  return res.rows[0]?.id || null;
}

/** Returns true if any of email OR phone OR street has been seen before. */
export async function hasExistingCustomer({ email, phone, street }) {
  if (!pool) return false; // no DB => treat as first-time (frontend will show half, backend won’t discount without DB)
  const e = (email || "").toLowerCase().trim();
  const p = String(phone || "");
  const s = (street || "").toLowerCase().trim();

  const q = `
    SELECT 1
    FROM bookings
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
}
