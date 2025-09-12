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

function money(pence) {
  return `£${(Number(pence) / 100).toFixed(0)}`;
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

/* -------------------- Env: prices and optional coupons ------------------- */
const ENV = {
  STANDARD_PRICE:        clean(process.env.STANDARD_PRICE || ""),
  STANDARD_INTRO_PRICE:  clean(process.env.STANDARD_INTRO_PRICE || ""),
  PREMIUM_PRICE:         clean(process.env.PREMIUM_PRICE || ""),
  PREMIUM_INTRO_PRICE:   clean(process.env.PREMIUM_INTRO_PRICE || ""),
  // Coupon IDs (duration=once). Make sure you set THESE names in Render:
  STANDARD_INTRO_COUPON: clean(process.env.STANDARD_INTRO_COUPON || ""),
  PREMIUM_INTRO_COUPON:  clean(process.env.PREMIUM_INTRO_COUPON || ""),
};

/* --------------------------- Public Routes -------------------------- */
/**
 * POST /api/memberships/subscribe
 * Body: { tier: "standard"|"premium", customer: {...}, first_time?: boolean }
 * If first_time=true AND coupon env exists:
 *   - Use NORMAL price in the line item
 *   - Apply COUPON at the **top level** as `discounts` (duration=once)
 *   - Add Checkout submit message (“Intro month £35, then £70 / month”)
 * Else (no coupon configured):
 *   - Fall back to intro price for first cycle, then flip to normal price via webhook.
 */
router.post("/subscribe", async (req, res) => {
  try {
    const { tier, customer, first_time } = req.body || {};
    if (!tier || !customer?.email) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    // Ensure a Stripe Customer for this user
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

    // Load prices (for building message)
    const standardPriceId = ENV.STANDARD_PRICE;
    const premiumPriceId  = ENV.PREMIUM_PRICE;
    if (!standardPriceId || !premiumPriceId) {
      return res.status(500).json({ ok: false, error: "price_not_configured" });
    }

    const [stdPrice, premPrice] = await Promise.all([
      stripe.prices.retrieve(standardPriceId),
      stripe.prices.retrieve(premiumPriceId),
    ]);
    const stdUnit  = stdPrice?.unit_amount ?? 0;   // pence
    const premUnit = premPrice?.unit_amount ?? 0;  // pence

    // Determine normal price + optional coupon for the chosen tier
    let normalPriceId = null;
    let couponId = null;
    if (tier === "standard") {
      normalPriceId = standardPriceId;
      couponId = first_time ? ENV.STANDARD_INTRO_COUPON : "";
    } else if (tier === "premium") {
      normalPriceId = premiumPriceId;
      couponId = first_time ? ENV.PREMIUM_INTRO_COUPON : "";
    } else {
      return res.status(400).json({ ok: false, error: "invalid_tier" });
    }

    const useCoupon = !!(first_time && couponId);

    // Build helpful submit message
    let submitMessage = "";
    if (useCoupon) {
      try {
        const c = await stripe.coupons.retrieve(couponId);
        const normal = tier === "standard" ? stdUnit : premUnit;
        if (c.amount_off && c.currency?.toLowerCase() === "gbp") {
          const intro = Math.max(0, normal - c.amount_off);
          submitMessage = `Intro month ${money(intro)}, then ${money(normal)} / month`;
        } else if (c.percent_off) {
          const intro = Math.round(normal * (1 - c.percent_off / 100));
          submitMessage = `Intro month ${money(intro)}, then ${money(normal)} / month`;
        } else {
          submitMessage = `Intro month applied, then ${money(normal)} / month`;
        }
      } catch {
        const normal = tier === "standard" ? stdUnit : premUnit;
        submitMessage = `Intro month applied, then ${money(normal)} / month`;
      }
    } else if (first_time && !useCoupon) {
      // Fallback: intro price flow (we will put a message, but the line item will be the intro price).
      const introPriceId = tier === "standard" ? ENV.STANDARD_INTRO_PRICE : ENV.PREMIUM_INTRO_PRICE;
      if (!introPriceId) {
        return res.status(500).json({ ok: false, error: "intro_price_not_configured" });
      }
      const intro = await stripe.prices.retrieve(introPriceId);
      const normal = tier === "standard" ? stdUnit : premUnit;
      submitMessage = `Intro month ${money(intro.unit_amount || normal)}, then ${money(normal)} / month`;
    }

    const origin = strictPublicOrigin();
    const success_url = `${origin}/?thankyou=1&flow=sub&sub=1`;
    const cancel_url  = `${origin}/?sub=cancel`;
    console.log(`[memberships] origin=${origin} success_url=${success_url} cancel_url=${cancel_url}`);

    // Build Checkout session
    const sessionParams = {
      customer: stripeCustomerId,
      mode: "subscription",
      success_url,
      cancel_url,
      custom_text: submitMessage ? { submit: { message: submitMessage } } : undefined,
      subscription_data: {
        metadata: {
          tier,
          method: useCoupon ? "coupon" : "intro_price",
          normal_price: ENV[`${tier.toUpperCase()}_PRICE`] || "",
          first_cycle_price: useCoupon ? "" : (ENV[`${tier.toUpperCase()}_INTRO_PRICE`] || ""),
        },
      },
      // IMPORTANT: discounts go at the TOP LEVEL for Checkout Sessions
      discounts: useCoupon ? [{ coupon: couponId }] : undefined,
      // Line item:
      line_items: useCoupon
        ? [{ price: normalPriceId, quantity: 1 }]
        : [{ price: tier === "standard" ? ENV.STANDARD_INTRO_PRICE : ENV.PREMIUM_INTRO_PRICE, quantity: 1 }],
    };

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[memberships/subscribe] failed:", err);
    return res.status(500).json({ ok: false, error: "subscribe_failed" });
  }
});

/* ------------------------ Webhook Utilities ------------------------- */
/** Flip to normal price next cycle — only needed for intro_price fallback. */
async function ensureNormalPriceForNextCycle(subscription) {
  try {
    const sub = typeof subscription === "string"
      ? await stripe.subscriptions.retrieve(subscription)
      : subscription;
    if (!sub) return;

    const method = sub.metadata?.method || "intro_price";
    if (method !== "intro_price") return; // If using coupons, no flip is required.

    const item = sub.items?.data?.[0];
    if (!item) return;

    const normal_price = sub.metadata?.normal_price || "";
    if (!normal_price) return;
    if (item.price?.id === normal_price) return;

    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: normal_price }],
      proration_behavior: "none",
      metadata: { ...sub.metadata, method: "coupon_or_normal" },
    });

    console.log(`[webhook] scheduled switch to normal price for next cycle on ${sub.id}`);
  } catch (e) {
    console.warn("[webhook] ensureNormalPriceForNextCycle failed:", e?.message);
  }
}

/* ------------------------ Webhook Entry Point ----------------------- */
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

      const tier = mapTierFromPrice(priceId) || sub.metadata?.tier || null;
      if (!tier) {
        console.log("[webhook] invoice.*: unmapped price and missing tier metadata", priceId);
        return;
      }

      // Resolve user id
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

      // Award credits (first cycle and every renewal)
      await awardCreditsForTier(userId, tier, currentPeriodEndSec);

      // Upsert subscription snapshot
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
      return;
  }
}

export default router;
