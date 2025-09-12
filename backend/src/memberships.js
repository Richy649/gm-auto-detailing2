// backend/src/memberships.js
import express from "express";
import Stripe from "stripe";
import { pool } from "./db.js";
import { awardCreditsForTier } from "./credits.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

/* ----------------------------- Helpers ----------------------------- */

function clean(s) {
  return (s ?? "").toString().replace(/[\u0000-\u001F\u007F\uFFFF]/g, "").trim();
}

function strictPublicOrigin() {
  const raw =
    clean(process.env.FRONTEND_PUBLIC_URL) ||
    clean(process.env.PUBLIC_APP_ORIGIN) ||
    clean(process.env.PUBLIC_FRONTEND_ORIGIN) ||
    "https://book.gmautodetailing.uk";
  let u;
  try { u = new URL(raw); } catch { throw new Error(`FRONTEND_PUBLIC_URL invalid: ${raw}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`Front-end origin must be http(s): ${raw}`);
  return u.origin;
}

function mapTierFromPrice(priceId) {
  const std       = clean(process.env.STANDARD_PRICE || "");
  const stdIntro  = clean(process.env.STANDARD_INTRO_PRICE || "");
  const prem      = clean(process.env.PREMIUM_PRICE || "");
  const premIntro = clean(process.env.PREMIUM_INTRO_PRICE || "");
  if ([std, stdIntro].filter(Boolean).includes(priceId)) return "standard";
  if ([prem, premIntro].filter(Boolean).includes(priceId)) return "premium";
  return null;
}

/* --------------------------- Public Routes -------------------------- */
/**
 * POST /api/memberships/subscribe
 * Body: { tier: "standard"|"premium", customer: {...}, first_time?: boolean }
 * On first_time=true: uses INTRO price for first cycle, then auto-switches to normal price.
 */
router.post("/subscribe", async (req, res) => {
  try {
    const { tier, customer, first_time } = req.body || {};
    if (!tier || !customer?.email) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    // Ensure a Stripe Customer
    let stripeCustomerId = null;
    const email = clean(customer.email);
    {
      const r = await pool.query(
        "SELECT stripe_customer_id FROM public.users WHERE lower(email)=lower($1) LIMIT 1",
        [email]
      );
      if (r.rowCount && r.rows[0].stripe_customer_id) {
        stripeCustomerId = r.rows[0].stripe_customer_id;
      }
    }
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({
        email,
        name: clean(customer.name) || undefined,
        phone: clean(customer.phone) || undefined,
        address:
          customer.street || customer.postcode
            ? { line1: clean(customer.street) || undefined, postal_code: clean(customer.postcode) || undefined }
            : undefined,
      });
      stripeCustomerId = sc.id;
      await pool.query(
        "UPDATE public.users SET stripe_customer_id=$1 WHERE lower(email)=lower($2)",
        [stripeCustomerId, email]
      );
    }

    // Prices
    const STANDARD       = clean(process.env.STANDARD_PRICE || "");
    const STANDARD_INTRO = clean(process.env.STANDARD_INTRO_PRICE || "");
    const PREMIUM        = clean(process.env.PREMIUM_PRICE || "");
    const PREMIUM_INTRO  = clean(process.env.PREMIUM_INTRO_PRICE || "");

    let priceFirstCycle = "";
    let normalPrice     = "";

    if (tier === "standard") {
      normalPrice     = STANDARD;
      priceFirstCycle = first_time && STANDARD_INTRO ? STANDARD_INTRO : STANDARD;
    } else if (tier === "premium") {
      normalPrice     = PREMIUM;
      priceFirstCycle = first_time && PREMIUM_INTRO ? PREMIUM_INTRO : PREMIUM;
    } else {
      return res.status(400).json({ ok: false, error: "invalid_tier" });
    }
    if (!priceFirstCycle) return res.status(500).json({ ok: false, error: "price_not_configured" });

    const origin = strictPublicOrigin();
    const success_url = `${origin}/?thankyou=1&flow=sub&sub=1`;
    const cancel_url  = `${origin}/?sub=cancel`;

    console.log(`[memberships] origin=${origin} success_url=${success_url} cancel_url=${cancel_url}`);

    // Create Stripe Checkout session for subscription
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "subscription",
      line_items: [{ price: priceFirstCycle, quantity: 1 }],
      success_url,
      cancel_url,
      subscription_data: {
        metadata: {
          tier,
          first_time: first_time ? "true" : "false",
          normal_price: normalPrice,
          first_cycle_price: priceFirstCycle,
        },
      },
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[memberships/subscribe] failed:", err);
    return res.status(500).json({ ok: false, error: "subscribe_failed" });
  }
});

/* ------------------------ Webhook Utilities ------------------------- */
/** Flip the subscription to the normal price for the next cycle if first_time=true. */
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
    if (!first_time || !normal_price) return;
    if (item.price?.id === normal_price) return;

    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: normal_price }],
      proration_behavior: "none",
      metadata: { ...sub.metadata, first_time: "false" },
    });

    console.log(`[webhook] scheduled switch to normal price for next cycle on ${sub.id}`);
  } catch (e) {
    console.warn("[webhook] ensureNormalPriceForNextCycle failed:", e?.message);
  }
}

/* ------------------------ Webhook Entry Point ----------------------- */
/**
 * Exported handler used by server.js
 * Awards credits on successful invoices (initial + renewals),
 * and applies the normal price for future cycles after intro.
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
      if (subId) await ensureNormalPriceForNextCycle(subId);
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
      const currentPeriodEndSec = sub.current_period_end; // unix seconds
      if (!customerId || !priceId) return;

      const tier = mapTierFromPrice(priceId);
      if (!tier) {
        console.log("[webhook] invoice.*: unmapped price", priceId);
        return;
      }

      // Find user by stripe_customer_id, or fallback by email
      let userId = null;
      {
        const r = await pool.query(
          "SELECT id FROM public.users WHERE stripe_customer_id=$1 LIMIT 1",
          [customerId]
        );
        if (r.rowCount) userId = r.rows[0].id;
      }
      if (!userId) {
        const sc = await stripe.customers.retrieve(customerId);
        const email = sc?.email;
        if (email) {
          const r2 = await pool.query(
            "SELECT id FROM public.users WHERE lower(email)=lower($1) LIMIT 1",
            [email]
          );
          if (r2.rowCount) {
            userId = r2.rows[0].id;
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

      // Award credits for this billing period
      await awardCreditsForTier(userId, tier, currentPeriodEndSec);

      // Optional: upsert subscription snapshot
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

      console.log(`[webhook] credits awarded — user=${userId}, tier=${tier}, period_end=${currentPeriodEndSec}`);
      return;
    }

    default:
      // Other events ignored
      return;
  }
}

export default router;
