// backend/src/migrations-temp.js
import { pool } from "./db.js";

const MIGRATION_SQL = `
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
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE,
  tier TEXT CHECK (tier IN ('standard','premium')),
  status TEXT,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
  service_type TEXT CHECK (service_type IN ('exterior','full')),
  qty INTEGER NOT NULL,
  kind TEXT CHECK (kind IN ('grant','debit','expire','adjust')),
  reason TEXT,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  related_booking_id INTEGER,
  stripe_invoice_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES public.users(id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_grant_invoice
ON public.credit_ledger (user_id, service_type, stripe_invoice_id)
WHERE kind = 'grant';

CREATE INDEX IF NOT EXISTS idx_ledger_user ON public.credit_ledger (user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_valid_until ON public.credit_ledger (valid_until);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (lower(email));
`;

export function mountMigrationRoute(app) {
  // Call once after deploy: POST /api/admin/migrate-memberships?token=YOUR_ADMIN_TOKEN
  app.post("/api/admin/migrate-memberships", async (req, res) => {
    try {
      if (req.query.token !== process.env.ADMIN_TOKEN)
        return res.status(401).json({ ok:false, error:"unauthorized" });
      await pool.query(MIGRATION_SQL);
      res.json({ ok:true, migrated:true });
    } catch (e) {
      console.error("[migrate-memberships]", e);
      res.status(500).json({ ok:false, error:"migration_failed" });
    }
  });
}
