// backend/src/credits.js
import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";

const router = express.Router();

/* ------------------------------------------------------------------ */
/*                          CREDIT UTILITIES                           */
/* ------------------------------------------------------------------ */

/**
 * Award membership credits for a billing period.
 * - tier: "standard" => +2 exterior
 * - tier: "premium"  => +2 full
 * valid_until is set to the Stripe subscription current_period_end (unix seconds).
 */
export async function awardCreditsForTier(userId, tier, currentPeriodEndSec) {
  if (!userId || !tier) return;

  const rows = [];
  if (tier === "standard") {
    rows.push({ service_type: "exterior", qty: 2 });
  } else if (tier === "premium") {
    rows.push({ service_type: "full", qty: 2 });
  } else {
    // Unknown tier — do nothing.
    return;
  }

  const validUntilExpr = currentPeriodEndSec
    ? "to_timestamp($3::bigint)"
    : "NULL";

  for (const r of rows) {
    const params = currentPeriodEndSec
      ? [userId, r.service_type, currentPeriodEndSec, r.qty]
      : [userId, r.service_type, r.qty];

    const sql = `
      INSERT INTO public.credit_ledger (user_id, service_type, qty, valid_until)
      VALUES ($1, $2, $${currentPeriodEndSec ? 3 : 3}, $${currentPeriodEndSec ? 4 : 3})
    `;

    // When no period end is provided, we want NULL valid_until and use qty as the 3rd param.
    // Build the sql dynamically to map params correctly.
    const finalSql = currentPeriodEndSec
      ? `INSERT INTO public.credit_ledger (user_id, service_type, valid_until, qty)
         VALUES ($1, $2, ${validUntilExpr}, $4)`
      : `INSERT INTO public.credit_ledger (user_id, service_type, qty)
         VALUES ($1, $2, $3)`;

    await pool.query(finalSql, params);
  }
}

/* ------------------------------------------------------------------ */
/*                       BOOK WITH CREDIT ENDPOINT                     */
/* ------------------------------------------------------------------ */

/**
 * Ensure the minimal bookings table exists so credit bookings can be recorded.
 * If you already have a bookings/appointments table, this will be a no-op due to IF NOT EXISTS.
 */
async function ensureBookingsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bookings (
      id               bigserial PRIMARY KEY,
      user_id          bigint NOT NULL,
      service_type     text   NOT NULL,   -- 'exterior' | 'full'
      start_ts         timestamptz NOT NULL,
      end_ts           timestamptz NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/**
 * Return live, non-expired credit balance for a user/service.
 */
async function getBalance(userId, serviceType) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(qty),0) AS bal
       FROM public.credit_ledger
      WHERE user_id=$1
        AND service_type=$2
        AND (valid_until IS NULL OR valid_until > now())`,
    [userId, serviceType]
  );
  return Number(r.rows?.[0]?.bal || 0);
}

/**
 * Deduct exactly one credit; we insert a -1 row.
 */
async function deductOneCredit(userId, serviceType) {
  await pool.query(
    `INSERT INTO public.credit_ledger (user_id, service_type, qty)
     VALUES ($1,$2,-1)`,
    [userId, serviceType]
  );
}

/**
 * Try to persist a booking record (for audit and UI). Not a scheduler — just a record.
 */
async function insertBooking(userId, serviceType, startIso, endIso) {
  await ensureBookingsSchema();
  await pool.query(
    `INSERT INTO public.bookings (user_id, service_type, start_ts, end_ts)
     VALUES ($1, $2, to_timestamp($3), to_timestamp($4))`,
    [
      userId,
      serviceType,
      Math.floor(new Date(startIso).getTime() / 1000),
      Math.floor(new Date(endIso).getTime() / 1000),
    ]
  );
}

/**
 * POST /api/credits/book-with-credit
 * Body: {
 *   service_key: 'exterior' | 'full',
 *   slot: { start_iso: string, end_iso: string },
 *   customer: { ...optional },
 *   origin?: string
 * }
 * Auth: Bearer token (authMiddleware sets req.user)
 */
router.post("/book-with-credit", authMiddleware, async (req, res) => {
  console.log("[credits] hit book-with-credit");

  try {
    if (!req.user?.id) {
      console.warn("[credits] missing auth user");
      return res.status(401).json({ ok: false, error: "auth_required" });
    }

    const body = req.body || {};
    const serviceKey = (body.service_key || "").toString();
    const slot = body.slot || {};

    if (serviceKey !== "exterior" && serviceKey !== "full") {
      console.warn("[credits] invalid service_key:", serviceKey);
      return res.status(400).json({ ok: false, error: "invalid_service" });
    }

    const startIso = slot.start_iso;
    const endIso = slot.end_iso;
    if (
      !startIso ||
      !endIso ||
      Number.isNaN(Date.parse(startIso)) ||
      Number.isNaN(Date.parse(endIso))
    ) {
      console.warn("[credits] invalid or missing slot:", slot);
      return res.status(400).json({ ok: false, error: "invalid_slot" });
    }

    // Check balance
    const bal = await getBalance(req.user.id, serviceKey);
    if (bal < 1) {
      console.warn("[credits] insufficient credits: have", bal, "need 1");
      return res.status(400).json({ ok: false, error: "insufficient_credits" });
    }

    // Optional duplicate check (same user/time)
    try {
      await ensureBookingsSchema();
      const clash = await pool.query(
        `SELECT 1 FROM public.bookings
          WHERE user_id=$1
            AND start_ts = to_timestamp($2)
            AND end_ts   = to_timestamp($3)
          LIMIT 1`,
        [
          req.user.id,
          Math.floor(new Date(startIso).getTime() / 1000),
          Math.floor(new Date(endIso).getTime() / 1000),
        ]
      );
      if (clash.rowCount) {
        console.warn("[credits] duplicate booking detected; returning success");
        return res.json({ ok: true, booked: true });
      }
    } catch (e) {
      console.warn("[credits] clash check skipped:", e?.message);
    }

    // Deduct 1 credit
    await deductOneCredit(req.user.id, serviceKey);

    // Record booking (best effort)
    try {
      await insertBooking(req.user.id, serviceKey, startIso, endIso);
    } catch (e) {
      console.warn("[credits] insert booking failed:", e?.message);
    }

    console.log(
      `[credits] booking created (user=${req.user.id}, service=${serviceKey}, start=${startIso})`
    );

    return res.json({ ok: true, booked: true });
  } catch (err) {
    console.error("[credits] book-with-credit failed:", err);
    return res.status(500).json({ ok: false, error: "credit_booking_failed" });
  }
});

export default router;
