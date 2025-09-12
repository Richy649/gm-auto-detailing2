import { pool } from "./db.js";

/**
 * Insert credits into the ledger. If `validUntilSec` is provided, set `valid_until`.
 * The caller (webhook) passes the subscription period end to align with your /auth/me query.
 */
async function insertLedgerCredits(userId, serviceType, qty, validUntilSec = null) {
  if (validUntilSec) {
    await pool.query(
      `INSERT INTO public.credit_ledger (user_id, service_type, qty, valid_until)
       VALUES ($1, $2, $3, to_timestamp($4))`,
      [userId, serviceType, qty, validUntilSec]
    );
  } else {
    await pool.query(
      `INSERT INTO public.credit_ledger (user_id, service_type, qty)
       VALUES ($1, $2, $3)`,
      [userId, serviceType, qty]
    );
  }
}

/**
 * Guard against duplicate awards for the same period & service.
 * This does not require schema changes and is safe if multiple rows exist historically.
 */
async function alreadyAwarded(userId, serviceType, qty, validUntilSec) {
  if (!validUntilSec) return false; // no way to scope to a period; allow insert
  const r = await pool.query(
    `SELECT 1
       FROM public.credit_ledger
      WHERE user_id=$1
        AND service_type=$2
        AND qty=$3
        AND valid_until = to_timestamp($4)
      LIMIT 1`,
    [userId, serviceType, qty, validUntilSec]
  );
  return r.rowCount > 0;
}

export async function addExteriorCredits(userId, count, validUntilSec = null) {
  if (await alreadyAwarded(userId, "exterior", count, validUntilSec)) return;
  await insertLedgerCredits(userId, "exterior", count, validUntilSec);
}

export async function addFullCredits(userId, count, validUntilSec = null) {
  if (await alreadyAwarded(userId, "full", count, validUntilSec)) return;
  await insertLedgerCredits(userId, "full", count, validUntilSec);
}

/**
 * Award credits based on membership tier.
 * - standard → +2 exterior credits
 * - premium  → +2 full credits
 * Period end is used for expiration to match your /auth/me balance computation.
 */
export async function awardCreditsForTier(userId, tier, periodEndSec = null) {
  if (tier === "standard") {
    await addExteriorCredits(userId, 2, periodEndSec);
  } else if (tier === "premium") {
    await addFullCredits(userId, 2, periodEndSec);
  }
}
