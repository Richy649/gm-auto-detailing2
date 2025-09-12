// backend/src/credits.js
import { Router } from "express";
import { pool, saveBooking } from "./db.js";
import { authMiddleware } from "./auth.js";
import { createCalendarEvents } from "./gcal.js";

const router = Router();

/* =================================================================== */
/*                     MEMBERSHIP CREDIT AWARDING                     */
/* =================================================================== */
/**
 * Award membership credits for a billing period.
 *  - tier "standard" => +2 exterior
 *  - tier "premium"  => +2 full
 * If currentPeriodEndSec is provided, credits get a valid_until = that timestamp.
 */
export async function awardCreditsForTier(userId, tier, currentPeriodEndSec) {
  if (!userId || !tier) return;

  const grants =
    tier === "standard"
      ? [{ service_type: "exterior", qty: 2 }]
      : tier === "premium"
      ? [{ service_type: "full", qty: 2 }]
      : [];

  if (!grants.length) return;

  const setValidUntil = Number.isFinite(currentPeriodEndSec);
  for (const g of grants) {
    if (setValidUntil) {
      await pool.query(
        `INSERT INTO public.credit_ledger (user_id, service_type, qty, valid_until, kind, reason)
         VALUES ($1,$2,$3,to_timestamp($4),'credit','membership_cycle')`,
        [userId, g.service_type, g.qty, currentPeriodEndSec]
      );
    } else {
      await pool.query(
        `INSERT INTO public.credit_ledger (user_id, service_type, qty, kind, reason)
         VALUES ($1,$2,$3,'credit','membership_cycle')`,
        [userId, g.service_type, g.qty]
      );
    }
  }
}

/* =================================================================== */
/*                         BOOK WITH CREDIT API                        */
/* =================================================================== */

const svcNames = { exterior: "Exterior Detail", full: "Full Detail" };

async function availableCredits(user_id, service_type) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(qty),0) AS bal
       FROM public.credit_ledger
      WHERE user_id=$1
        AND service_type=$2
        AND (valid_until IS NULL OR valid_until > now())`,
    [user_id, service_type]
  );
  return Number(r.rows?.[0]?.bal || 0);
}

async function hasDuplicateBooking(user_id, startISO, endISO) {
  // Uses your canonical columns via saveBooking elsewhere; here we check against the same timestamps.
  const q = `
    SELECT 1
      FROM public.bookings
     WHERE user_id = $1
       AND start_time = $2::timestamptz
       AND end_time   = $3::timestamptz
     LIMIT 1
  `;
  const r = await pool.query(q, [user_id, startISO, endISO]);
  return r.rowCount > 0;
}

async function deductOneCredit(user_id, service_type, bookingId) {
  await pool.query(
    `INSERT INTO public.credit_ledger
       (user_id, service_type, qty, kind, reason, related_booking_id)
     VALUES ($1,$2,-1,'debit',$3,$4)`,
    [user_id, service_type, `booking ${bookingId}`, bookingId]
  );
}

/**
 * POST /api/credits/book-with-credit
 * Body: {
 *   service_key: 'exterior' | 'full',
 *   slot: { start_iso: string, end_iso: string },
 *   customer?: { name?, email?, phone?, street?, postcode? },
 *   origin?: string
 * }
 * Auth: Bearer (authMiddleware)
 */
router.post("/book-with-credit", authMiddleware, async (req, res) => {
  console.log("[credits] hit book-with-credit");

  try {
    if (!req.user?.id) {
      console.warn("[credits] missing auth user");
      return res.status(401).json({ ok: false, error: "auth_required" });
    }

    const body = req.body || {};
    const service_key = String(body.service_key || "");
    const slot = body.slot || {};
    const start_iso = slot.start_iso;
    const end_iso = slot.end_iso;

    if (service_key !== "exterior" && service_key !== "full") {
      console.warn("[credits] invalid service_key:", service_key);
      return res.status(400).json({ ok: false, error: "invalid_service" });
    }
    if (!start_iso || !end_iso || Number.isNaN(Date.parse(start_iso)) || Number.isNaN(Date.parse(end_iso))) {
      console.warn("[credits] invalid slot:", slot);
      return res.status(400).json({ ok: false, error: "invalid_slot" });
    }

    const bal = await availableCredits(req.user.id, service_key);
    if (bal < 1) {
      console.warn("[credits] insufficient credits: have", bal, "need 1");
      return res.status(400).json({ ok: false, error: "insufficient_credits" });
    }

    if (await hasDuplicateBooking(req.user.id, start_iso, end_iso)) {
      console.log("[credits] duplicate detected; returning success");
      return res.json({ ok: true, booked: true });
    }

    // Persist booking using your canonical helper (correct columns + customer fields).
    const bookingId = await saveBooking({
      user_id: req.user.id,
      stripe_session_id: null,         // not a Stripe session
      service_key,
      addons: [],                      // credits pay base service only
      start_iso,
      end_iso,
      customer: body.customer || {},
      has_tap: true,
    });

    // Deduct exactly one credit, linked to the booking.
    await deductOneCredit(req.user.id, service_key, bookingId);

    // Create Google Calendar event (best-effort).
    try {
      const sessionId = `credit:${bookingId}`; // deterministic for calendar event id
      const items = [{
        start_iso,
        end_iso,
        summary: `GM Auto Detailing — ${svcNames[service_key] || service_key}`,
        description: [
          `Paid with 1 membership credit`,
          body.customer?.name ? `Name: ${body.customer.name}` : null,
          body.customer?.phone ? `Phone: ${body.customer.phone}` : null,
          body.customer?.email ? `Email: ${body.customer.email}` : null,
          body.customer?.street || body.customer?.postcode
            ? `Address: ${body.customer.street || ""} ${body.customer.postcode || ""}`.trim()
            : null,
          `Booking ID: ${bookingId}`,
        ].filter(Boolean).join("\n"),
        location: `${body.customer?.street || ""}, ${body.customer?.postcode || ""}`.trim(),
      }];
      await createCalendarEvents(sessionId, items);
    } catch (e) {
      console.warn("[gcal] create events failed", e?.message || e);
    }

    console.log(`[credits] booking created (user=${req.user.id}, service=${service_key}, start=${start_iso})`);
    return res.json({ ok: true, booked: true, booking_id: bookingId });
  } catch (err) {
    console.error("[credits] book-with-credit failed:", err);
    return res.status(500).json({ ok: false, error: "credit_booking_failed" });
  }
});

export default router;
