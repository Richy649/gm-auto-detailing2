import express from "express";
import Stripe from "stripe";
import { pool } from "./db.js";
import { awardCreditsForTier } from "./credits.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

/* ----------------------------- Helpers ----------------------------- */

function hardSanitize(str) {
  if (!str) return "";
  return String(str).replace(/[\u0000-\u001F\u007F-\uFFFF]/g, "").trim();
}

function tierFromPriceId(priceId) {
  const std       = hardSanitize(process.env.STANDARD_PRICE || "");
  const stdIntro  = hardSanitize(process.env.STANDARD_INTRO_PRICE || "");
  const prem      = hardSanitize(process.env.PREMIUM_PRICE || "");
  const premIntro = hardSanitize(process.env.PREMIUM_INTRO_PRICE || "");

  if ([std, stdIntro].filter(Boolean).includes(priceId)) return "standard";
  if ([prem, premIntro].filter(Boolean).includes(priceId)) return "premium";
  return null;
}

function resolvePublicOriginStrict() {
  const raw = hardSanitize(process.env.FRONTEND_PUBLIC_URL || "");
  if (!raw) {
    throw new Error(
      "FRONTEND_PUBLIC_URL must be set to a full URL, e.g. https://book.gmautodetailing.uk"
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`FRONTEND_PUBLIC_URL is not a valid URL: ${raw}`);
  }
  if (!(parsed.protocol === "https:" || parsed.protocol === "http:")) {
    throw new Error(`FRONTEND_PUBLIC_URL must be http(s): ${raw}`);
  }
  return parsed.origin;
}

/* --------------------------- Public Routes -------------------------- */

router.get("/debug-url", (_req, res) => {
  try {
    const origin = resolvePublicOriginStrict();
    const success_url = `${origin}/?sub=1&thankyou=1&flow=sub`;
    const cancel_url  = `${origin}/?sub=cancel`;
    return res.json({ ok: true, origin, success_url, cancel_url });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

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
        ? hardSanitize(process.env.STANDARD_PRICE || "")
        : tier === "premium"
        ? hardSanitize(process.env.PREMIUM_PRICE || "")
        : "";

    if (!priceId) {
      return res.status(400).json({ ok: false, error: "invalid_tier" });
    }

    // Build success/cancel URLs from FRONTEND_PUBLIC_URL origin only
    const origin = resolvePublicOriginStrict();
    const success_url = `${origin}/?sub=1&thankyou=1&flow=sub`;
    const cancel_url  = `${origin}/?sub=cancel`;

    console.log(`[memberships] origin=${origin} success_url=${success_url} cancel_url=${cancel_url}`);

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

async function settleAndAwardFromSubscriptionId(subscriptionId) {
  if (!subscriptionId) return;

  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = sub.customer;
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id;
  const currentPeriodEndSec = sub.current_period_end; // UNIX seconds
  if (!customerId || !priceId) return;

  const tier = tierFromPriceId(priceId);
  if (!tier) return;

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

  // Award credits into the ledger for this billing period (idempotent via period end)
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
      [userId, tier, sub.status || "active", sub.current_period_start, sub.current_period_end]
    );
  } catch (e) {
    console.warn("[webhook] subscriptions upsert skipped:", e?.message);
  }

  console.log(
    `[webhook] credits awarded for user ${userId} — tier=${tier}, period_end=${currentPeriodEndSec}`
  );
}

export async function handleMembershipWebhook(event) {
  // Handle multiple relevant events to be robust across Stripe flows.
  switch (event.type) {
    case "invoice.payment_succeeded":
    case "invoice.paid": {
      const invoice = event.data.object;
      await settleAndAwardFromSubscriptionId(invoice?.subscription);
      return;
    }

    case "checkout.session.completed": {
      const session = event.data.object;
      // Only for subscription mode
      if (session?.mode !== "subscription") return;

      // If payment is confirmed or the resulting subscription is active, award now.
      // session.subscription can be an ID string.
      const subscriptionId = typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id;

      if (!subscriptionId) return;

      // Safety: only award if paid or active (covers trials that still activate immediately).
      const paid = session.payment_status === "paid";
      if (paid) {
        await settleAndAwardFromSubscriptionId(subscriptionId);
        return;
      }

      // If not clearly paid, check the subscription status directly.
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        if (sub?.status === "active" || sub?.status === "trialing") {
          await settleAndAwardFromSubscriptionId(subscriptionId);
        }
      } catch (e) {
        console.warn("[webhook] could not inspect subscription on session.completed:", e?.message);
      }
      return;
    }

    default:
      console.log(`[webhook] unhandled event type: ${event.type}`);
      return;
  }
}

export default router;
