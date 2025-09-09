// backend/src/credits.js
import { Router } from "express";
import Stripe from "stripe";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";
import { saveBooking } from "./db.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = Router();

const serviceTypeByKey = { exterior: "exterior", full: "full" }; // map UI keys to credit type

async function availableCredits(user_id, service_type) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(qty),0) AS bal
     FROM public.credit_ledger
     WHERE user_id=$1 AND service_type=$2 AND (valid_until IS NULL OR valid_until > now())`,
    [user_id, service_type]
  );
  return Number(r.rows[0]?.bal || 0);
}

async function debitOne(user_id, service_type, booking_id) {
  await pool.query(
    `INSERT INTO public.credit_ledger (user_id, service_type, qty, kind, reason, related_booking_id)
     VALUES ($1,$2,-1,'debit',$3,$4)`,
    [user_id, service_type, `booking ${booking_id}`, booking_id]
  );
}

router.use(authMiddleware);

/**
 * POST /api/credits/book-with-credit
 * Body: { service_key: 'exterior'|'full', slot: {start_iso,end_iso}, addons: ['wax','polish'], customer: {name,phone,email,street,postcode}, origin }
 * - If addons total > 0, returns { ok:true, checkout_url } (debit happens in webhook after success)
 * - If addons total == 0, creates booking + debits immediately and returns { ok:true, booked:true }
 */
router.post("/book-with-credit", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });

    const { service_key, slot, addons = [], customer = {}, origin } = req.body || {};
    if (!service_key || !slot?.start_iso || !slot?.end_iso) return res.status(400).json({ ok:false, error:"missing_fields" });

    const service_type = serviceTypeByKey[service_key];
    if (!service_type) return res.status(400).json({ ok:false, error:"invalid_service" });

    const bal = await availableCredits(req.user.id, service_type);
    if (bal < 1) return res.status(402).json({ ok:false, error:"no_credits" });

    // compute addons total using your /api/config prices (hard-code fallback)
    const addonsPrices = { wax: 10, polish: 22.5 };
    const addonsTotal = addons.reduce((s,k)=> s + (addonsPrices[k]||0), 0);

    if (addonsTotal > 0) {
      // Create a lightweight checkout for add-ons only (service paid by credit)
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "gbp",
            product_data: { name: `Add-ons for ${service_key} (credit)` },
            unit_amount: Math.round(addonsTotal * 100),
          },
          quantity: 1
        }],
        success_url: `${(origin || process.env.PUBLIC_FRONTEND_ORIGIN)}?paid=1`,
        cancel_url:  (origin || process.env.PUBLIC_FRONTEND_ORIGIN),
        metadata: {
          kind: "addons_only_with_credit",
          user_id: String(req.user.id),
          service_key,
          start_iso: slot.start_iso,
          end_iso: slot.end_iso,
          addons: JSON.stringify(addons),
          customer: JSON.stringify(customer || {})
        }
      });
      return res.json({ ok:true, url: session.url });
    }

    // No addons -> book immediately and debit 1 credit
    const bookingId = await saveBooking({
      stripe_session_id: null,
      service_key,
      addons,
      start_iso: slot.start_iso,
      end_iso: slot.end_iso,
      customer,
      has_tap: true
    });
    await debitOne(req.user.id, service_type, bookingId);
    return res.json({ ok:true, booked:true, booking_id: bookingId });

  } catch (e) {
    console.error("[book-with-credit] err", e);
    res.status(500).json({ ok:false, error:"book_credit_failed" });
  }
});

export default router;
