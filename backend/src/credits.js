// backend/src/credits.js
import { Router } from "express";
import Stripe from "stripe";
import { pool, saveBooking } from "./db.js";
import { authMiddleware } from "./auth.js";

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.use(authMiddleware);

async function availableCredits(user_id, service_type) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(qty),0) AS bal
     FROM public.credit_ledger
     WHERE user_id=$1 AND service_type=$2 AND (valid_until IS NULL OR valid_until > now())`,
    [user_id, service_type]
  );
  return Number(r.rows[0]?.bal || 0);
}

router.post("/book-with-credit", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });

    const { service_key, slot, addons = [], customer = {}, origin } = req.body || {};
    if (!service_key || !slot?.start_iso || !slot?.end_iso) return res.status(400).json({ ok:false, error:"missing_fields" });

    const service_type = service_key === "full" ? "full" : "exterior";
    const bal = await availableCredits(req.user.id, service_type);
    if (bal < 1) return res.status(402).json({ ok:false, error:"no_credits" });

    // addons sum (fallback values)
    const addonsPrices = { wax: 10, polish: 22.5 };
    const addonsTotal = addons.reduce((s,k)=> s + (addonsPrices[k]||0), 0);

    if (addonsTotal > 0) {
      // Pay add-ons only; service uses credit. Booking + debit happens in webhook.
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "gbp",
            product_data: { name: `Add-ons for ${service_key} (credit applied)` },
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

    // No add-ons → save booking now and debit immediately
    const bookingId = await saveBooking({
      stripe_session_id: null,
      service_key,
      addons,
      start_iso: slot.start_iso,
      end_iso: slot.end_iso,
      customer,
      has_tap: true
    });
    await pool.query(
      `INSERT INTO public.credit_ledger (user_id, service_type, qty, kind, reason, related_booking_id)
       VALUES ($1,$2,-1,'debit',$3,$4)`,
      [req.user.id, service_type, `booking ${bookingId}`, bookingId]
    );
    res.json({ ok:true, booked:true, booking_id: bookingId });

  } catch (e) {
    console.error("[book-with-credit]", e);
    res.status(500).json({ ok:false, error:"book_credit_failed" });
  }
});

export default router;
