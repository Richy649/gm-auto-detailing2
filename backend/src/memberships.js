// backend/src/memberships.js
import express from "express";
import Stripe from "stripe";
import { pool } from "./db.js";
import { awardCreditsForTier } from "./credits.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

/* ----------------------------- Helpers ----------------------------- */

function hardSanitize(str) {
  if (!str) return "";
  return String(str).replace(/[\u0000-\u001F\u007F\uFFFF]/g, "").trim();
}

/**
 * Map Stripe price IDs to internal tiers.
 */
function tierFromPriceId(priceId) {
  const std       = hardSanitize(process.env.STANDARD_PRICE || "");
  const stdIntro  = hardSanitize(process.env.STANDARD_INTRO_PRICE || "");
  const prem      = hardSanitize(process.env.PREMIUM_PRICE || "");
  const premIntro = hardSanitize(process.env.PREMIUM_INTRO_PRICE || "");

  if ([std, stdIntro].filter(Boolean).includes(priceId)) return "standard";
  if ([prem, premIntro].filter(Boolean).includes(priceId)) return "premium";
  return null;
}

/**
 * Strictly resolve the public origin for success/cancel URLs from FRONTEND_PUBLIC_URL.
 */
function resolvePublicOriginStrict() {
  const raw = hardSanitize(process.env.FRONTEND_PUBLIC_URL || "");
  if (!raw) {
    throw new Error(
      "FRONTEND_PUBLIC_URL must be set to a full URL, e.g. https://book.gmautodetailing.uk"
    );
  }
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`FRONTEND_PUBLIC_URL is not a valid URL: ${raw}`); }
  if (!(parsed.protocol === "https:" || parsed.protocol === "http:")) {
    throw new Error(`FRONTEND_PUBLIC_URL must be http(s): ${raw}`);
  }
  return parsed.origin;
}

/* --------------------------- Public Routes -------------------------- */
/**
 * POST /api/memberships/subscribe
 * Body: { tier: "standard"|"premium", customer: {...}, first_time?: boolean }
 * If first_time=true and an intro price is configured, we start with the intro price,
 * then schedule updating the subscription to the normal price from the next cycle.
 */
router.post("/subscribe", async (req, res) => {
  try {
    const { tier, customer, first_time } = req.body || {};
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

    // Choose price (intro for first month if first_time=true and intro price exists)
    const STANDARD          = hardSanitize(process.env.STANDARD_PRICE || "");
    const STANDARD_INTRO    = hardSanitize(process.env.STANDARD_INTRO_PRICE || "");
    const PREMIUM           = hardSanitize(process.env.PREMIUM_PRICE || "");
    const PREMIUM_INTRO     = hardSanitize(process.env.PREMIUM_INTRO_PRICE || "");

    let priceForFirstCycle = "";
    let normalPrice        = "";

    if (tier === "standard") {
      normalPrice        = STANDARD;
      priceForFirstCycle = first_time && STANDARD_INTRO ? STANDARD_INTRO : STANDARD;
    } else if (tier === "premium") {
      normalPrice        = PREMIUM;
      priceForFirstCycle = first_time && PREMIUM_INTRO ? PREMIUM_INTRO : PREMIUM;
    } else {
      return res.status(400).json({ ok: false, error: "invalid_tier" });
    }
    if (!priceForFirstCycle) {
      return res.status(500).json({ ok: false, error: "price_not_configured" });
    }

    // Build success/cancel URLs from FRONTEND_PUBLIC_URL origin only
    const origin = resolvePublicOriginStrict();
    const success_url = `${origin}/?thankyou=1&flow=sub&sub=1`;
    const cancel_url  = `${origin}/?sub=cancel`;

    console.log(`[memberships] origin=${origin} success_url=${success_url} cancel_url=${cancel_url}`);

    // Create checkout session in subscription mode using the first-cycle price
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "subscription",
      line_items: [{ price: priceForFirstCycle, quantity: 1 }],
      success_url,
      cancel_url,
      subscription_data: {
        metadata: {
          tier,
          first_cycle_price: priceForFirstCycle,
          normal_price: normalPrice,
          first_time: first_time ? "true" : "false",
        },
      },
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[memberships/subscribe] failed:", err);
    return res.status(500).json({ ok: false, error: "subscribe_failed" });
  }
});

/* ------------------------ Webhook Entry Point ----------------------- */
/**
 * After the subscription is created (via checkout.session.completed), if this was a first-time
 * customer with an intro price, we programmatically update the subscription’s price to the
 * “normal” price for the next billing cycle. Credits are still awarded per cycle elsewhere.
 */
async function ensureNormalPriceForNextCycle(subscription) {
  try {
    const sub = typeof subscription === "string"
      ? await stripe.subscriptions.retrieve(subscription)
      : subscription;

    if (!sub) return;
    const item = sub.items?.data?.[0];
    if (!item) return;

    const first_time = sub.metadata?.first_time === "true";
    const normal_price = sub.metadata?.normal_price || "";
    if (!first_time || !normal_price) return; // nothing to do

    // If already on normal price, skip
    if (item.price?.id === normal_price) return;

    await stripe.subscriptions.update(sub.id, {
      items: [
        { id: item.id, price: normal_price },
      ],
      proration_behavior: "none",
      metadata: {
        ...sub.metadata,
        first_time: "false",
      },
    });

    console.log(`[webhook] scheduled normal price for next cycle on sub ${sub.id}`);
  } catch (e) {
    console.warn("[webhook] ensureNormalPriceForNextCycle failed:", e?.message);
  }
}

/**
 * Called by server.js after Stripe signature verification.
 * Awards credits on subscription invoices (initial + renewals) and applies next-cycle price.
 */
export async function handleMembershipWebhook(event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session?.mode !== "subscription") return;
      const subId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
      if (!subId) return;

      // If intro cycle was used, schedule normal price for next cycle
      await ensureNormalPriceForNextCycle(subId);
      return;
    }

    case "invoice.payment_succeeded":
    case "invoice.paid": {
      const invoice = event.data.object;
      const subscriptionId = invoice?.subscription;
      if (!subscriptionId) return;

      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const customerId = sub.customer;
      const item = sub.items?.data?.[0];
      const priceId = item?.price?.id;
      const currentPeriodEndSec = sub.current_period_end; // UNIX seconds
      if (!customerId || !priceId) return;

      // Map price to tier
      const std       = hardSanitize(process.env.STANDARD_PRICE || "");
      const stdIntro  = hardSanitize(process.env.STANDARD_INTRO_PRICE || "");
      const prem      = hardSanitize(process.env.PREMIUM_PRICE || "");
      const premIntro = hardSanitize(process.env.PREMIUM_INTRO_PRICE || "");

      let tier = null;
      if ([std, stdIntro].filter(Boolean).includes(priceId)) tier = "standard";
      else if ([prem, premIntro].filter(Boolean).includes(priceId)) tier = "premium";
      if (!tier) {
        console.log("[webhook] invoice.*: unmapped price", priceId);
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

      // Optional: persist subscription status
      try {
        await pool.query(
          `INSERT INTO public.subscriptions (user_id, tier, status, current_period_start, current_period_end, updated_at)
           VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5), now())
           ON CONFLICT (user_id, tier) DO UPDATE
             SET status=EXCLUDED.status,
                 current_period_start=EXCLUDED.current_period_start,
                 current_period_end=EXCLUDED.current_period_end,
                 updated_at=now()`,
          [userId, tier, sub.status || "active", sub.current_period_start, sub.current_period_end]
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
