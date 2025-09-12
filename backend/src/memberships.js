import express from "express";
import Stripe from "stripe";
import * as db from "./db.js";   // ✅ fixed: import all named exports
import {
  addExteriorCredits,
  addFullCredits,
  awardCreditsForTier,
} from "./credits.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

/* ----------------------------- Helpers ----------------------------- */
function tierFromPriceId(priceId) {
  const std = process.env.STANDARD_PRICE;
  const stdIntro = process.env.STANDARD_INTRO_PRICE;
  const prem = process.env.PREMIUM_PRICE;
  const premIntro = process.env.PREMIUM_INTRO_PRICE;

  if ([std, stdIntro].includes(priceId)) return "standard";
  if ([prem, premIntro].includes(priceId)) return "premium";
  return null;
}

/* --------------------------- Public Routes -------------------------- */
router.post("/subscribe", async (req, res) => {
  try {
    const { tier, customer, origin } = req.body || {};
    if (!tier || !customer?.email) {
      return res.status(400).json({ ok: false, error: "Missing tier or customer email" });
    }

    // Find existing stripe_customer_id if present
    let stripeCustomerId = null;
    const r = await db.query(
      "SELECT stripe_customer_id FROM users WHERE email=$1 LIMIT 1",
      [customer.email]
    );
    if (r.rows.length && r.rows[0].stripe_customer_id) {
      stripeCustomerId = r.rows[0].stripe_customer_id;
    }

    // Create a Stripe customer if none exists
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({
        email: customer.email,
        name: customer.name || undefined,
        phone: customer.phone || undefined,
        address: (customer.street || customer.postcode)
          ? { line1: customer.street || undefined, postal_code: customer.postcode || undefined }
          : undefined,
      });
      stripeCustomerId = sc.id;

      // Persist the customer id if the user already exists
      await db.query(
        "UPDATE users SET stripe_customer_id=$1 WHERE email=$2",
        [stripeCustomerId, customer.email]
      );
    }

    const priceId =
      tier === "standard" ? process.env.STANDARD_PRICE
      : tier === "premium" ? process.env.PREMIUM_PRICE
      : null;

    if (!priceId) {
      return res.status(400).json({ ok: false, error: "Invalid tier" });
    }

    const successBase = process.env.FRONTEND_PUBLIC_URL || process.env.PUBLIC_APP_ORIGIN || origin || "";
    const success_url = `${successBase}/?sub=1&thankyou=1&flow=sub`;
    const cancel_url = `${successBase}/?sub=cancel`;

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url,
      cancel_url,
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[memberships/subscribe] failed:", err);
    return res.status(500).json({ ok: false, error: "Unable to create subscription" });
  }
});

/* ------------------------ Webhook Entry Point ----------------------- */
export async function handleMembershipWebhook(event) {
  switch (event.type) {
    case "invoice.payment_succeeded": {
      const invoice = event.data.object;
      const subscriptionId = invoice?.subscription;
      if (!subscriptionId) return;

      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const customerId = sub.customer;
      const priceId = sub.items?.data?.[0]?.price?.id;
      if (!customerId || !priceId) return;

      const tier = tierFromPriceId(priceId);
      if (!tier) return;

      const ur = await db.query(
        "SELECT id, email FROM users WHERE stripe_customer_id=$1 LIMIT 1",
        [customerId]
      );

      let userId = ur.rows[0]?.id;
      if (!userId) {
        const sc = await stripe.customers.retrieve(customerId);
        const email = sc?.email;
        if (email) {
          const er = await db.query("SELECT id FROM users WHERE email=$1 LIMIT 1", [email]);
          if (er.rows.length) {
            userId = er.rows[0].id;
            await db.query("UPDATE users SET stripe_customer_id=$1 WHERE id=$2", [customerId, userId]);
          }
        }
      }
      if (!userId) {
        console.warn("[webhook] No user matched for customer:", customerId);
        return;
      }

      await awardCreditsForTier(userId, tier);
      console.log(`[webhook] Awarded credits for user ${userId} (tier=${tier})`);
      return;
    }

    default:
      console.log(`[webhook] Unhandled event type: ${event.type}`);
      return;
  }
}

export default router;
