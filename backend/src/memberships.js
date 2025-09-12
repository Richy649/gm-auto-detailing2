import express from "express";
import Stripe from "stripe";
import { pool } from "./db.js";
import { awardCreditsForTier } from "./credits.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

/* ----------------------------- Helpers ----------------------------- */

/**
 * Map Stripe price IDs to internal tiers.
 */
function tierFromPriceId(priceId) {
  const std       = (process.env.STANDARD_PRICE || "").trim();
  const stdIntro  = (process.env.STANDARD_INTRO_PRICE || "").trim();
  const prem      = (process.env.PREMIUM_PRICE || "").trim();
  const premIntro = (process.env.PREMIUM_INTRO_PRICE || "").trim();

  if ([std, stdIntro].filter(Boolean).includes(priceId)) return "standard";
  if ([prem, premIntro].filter(Boolean).includes(priceId)) return "premium";
  return null;
}

/**
 * Strictly resolve the public base URL for redirects.
 * We intentionally *only* accept FRONTEND_PUBLIC_URL because:
 *  - It’s your canonical booking app origin (e.g., https://book.gmautodetailing.uk).
 *  - It avoids accidental fallback to non-URL envs (like FRONTEND_ORIGIN without scheme).
 *  - It ensures Stripe redirects load your app at top-level (not the Squarespace embed).
 */
function resolveFrontendPublicUrl() {
  const raw = (process.env.FRONTEND_PUBLIC_URL || "").trim();
  if (!raw) {
    throw new Error("FRONTEND_PUBLIC_URL must be set to a full URL, e.g. https://book.gmautodetailing.uk");
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`FRONTEND_PUBLIC_URL is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`FRONTEND_PUBLIC_URL must be http(s): ${raw}`);
  }
  // Normalise to no trailing slash for stable concatenation
  return u.toString().replace(/\/+$/, "");
}

/* --------------------------- Public Routes -------------------------- */
/**
 * POST /api/memberships/subscribe
 * Creates a Stripe Checkout Session for subscription sign-up.
 * Credits are NOT awarded here; they are awarded by the webhook upon payment.
 */
router.post("/subscribe", async (req, res) => {
  try {
    const { tier, customer } = req.body || {};
    if (!tier || !customer?.email) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    // Look up stripe_customer_id for this user (if any)
    let stripeCustomerId = null;
    {
      const r = await pool.query(
        "SELECT stripe_customer_id FROM public.users WHERE lower(email)=lower($1) LIMIT 1",
        [customer.email]
      );
      if (r.rowCount && r.rows[0].stripe_customer_id) {
        stripeCustomerId = r.rows[0].stripe_customer_id;
      }
    }

    // Create Stripe Customer if none exists yet
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({
        email: customer.email,
        name: customer.name || undefined,
        phone: customer.phone || undefined,
        address:
          customer.street || customer.postcode
            ? { line1: customer.street || undefined, postal_code: customer.postcode || undefined }
            : undefined,
      });
      stripeCustomerId = sc.id;

      // Persist onto user row if user already exists
      await pool.query(
        "UPDATE public.users SET stripe_customer_id=$1 WHERE lower(email)=lower($2)",
        [stripeCustomerId, customer.email]
      );
    }

    // Select price by tier
    const priceId =
      tier === "standard"
        ? (process.env.STANDARD_PRICE || "").trim()
        : tier === "premium"
        ? (process.env.PREMIUM_PRICE || "").trim()
        : "";

    if (!priceId) {
      return res.status(400).json({ ok: false, error: "invalid_tier" });
    }

    // Build strict success/cancel URLs from FRONTEND_PUBLIC_URL only
    const base = resolveFrontendPublicUrl();
    console.log(`[memberships] using FRONTEND_PUBLIC_URL: ${base}`);
    const success_url = new URL("/?sub=1&thankyou=1&flow=sub", base).toString();
    const cancel_url  = new URL("/?sub=cancel", base).toString();

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
    return res.status(500).json({ ok: false, error: "subscribe_failed" });
  }
});

/* ------------------------ Webhook Entry Point ----------------------- */
/**
 * Called by server.js after Stripe signature verification.
 * Awards credits on subscription invoices (initial + renewals).
 */
export async function handleMembershipWebhook(event) {
  switch (event.type) {
    case "invoice.payment_succeeded": {
      const invoice = event.data.object;
      const subscriptionId = invoice?.subscription;
      if (!subscriptionId) return;

      // Retrieve subscription to determine period and items
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const customerId = sub.customer;
      const item = sub.items?.data?.[0];
      const priceId = item?.price?.id;
      const currentPeriodEndSec = sub.current_period_end; // Unix epoch seconds
      if (!customerId || !priceId) return;

      const tier = tierFromPriceId(priceId);
      if (!tier) {
        console.log("[webhook] invoice.payment_succeeded: unmapped price", priceId);
        return;
      }

      // Find user by stripe_customer_id
      let userId = null;
      {
        const ur = await pool.query(
          "SELECT id, email FROM public.users WHERE stripe_customer_id=$1 LIMIT 1",
          [customerId]
        );
        if (ur.rowCount) userId = ur.rows[0].id;
      }

      // Fallback: reconcile via Stripe Customer email, then backfill customer id
      if (!userId) {
        const sc = await stripe.customers.retrieve(customerId);
        const email = sc?.email;
        if (email) {
          const er = await pool.query(
            "SELECT id FROM public.users WHERE lower(email)=lower($1) LIMIT 1",
            [email]
          );
          if (er.rowCount) {
            userId = er.rows[0].id;
            await pool.query(
              "UPDATE public.users SET stripe_customer_id=$1 WHERE id=$2",
              [customerId, userId]
            );
          }
        }
      }
      if (!userId) {
        console.warn("[webhook] no user matched for customer:", customerId);
        return;
      }

      // Award credits into the ledger for this billing period
      await awardCreditsForTier(userId, tier, currentPeriodEndSec);

      // Optional: persist subscription status for dashboard logic
      try {
        await pool.query(
          `INSERT INTO public.subscriptions (user_id, tier, status, current_period_start, current_period_end, updated_at)
           VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5), now())
           ON CONFLICT (user_id, tier) DO UPDATE
             SET status=EXCLUDED.status,
                 current_period_start=EXCLUDED.current_period_start,
                 current_period_end=EXCLUDED.current_period_end,
                 updated_at=now()`,
          [userId, tier, "active", sub.current_period_start, sub.current_period_end]
        );
      } catch (e) {
        console.warn("[webhook] subscriptions upsert skipped:", e?.message);
      }

      console.log(
        `[webhook] credits awarded for user ${userId} — tier=${tier}, period_end=${currentPeriodEndSec}`
      );
      return;
    }

    default:
      console.log(`[webhook] unhandled event type: ${event.type}`);
      return;
  }
}

export default router;
