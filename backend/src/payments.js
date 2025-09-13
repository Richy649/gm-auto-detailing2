// backend/src/payments.js
import express from "express";
import Stripe from "stripe";
import { hasExistingCustomer /*, saveBooking */ } from "./db.js";
// If you later want calendar entries from the one-off flow, you can re-enable:
// import { createCalendarEvents } from "./gcal.js";

/**
 * One-off payments + webhook + confirm endpoint
 *
 * ENV expected (one-off):
 *   STRIPE_SECRET_KEY        = sk_test_... / sk_live_...
 *   STRIPE_WEBHOOK_SECRET    = whsec_...   (one-off webhook secret)
 *   ONEOFF_EXTERIOR_PRICE    = price_xxx   (Stripe Price for Exterior Detail)
 *   ONEOFF_FULL_PRICE        = price_xxx   (Stripe Price for Full Detail)
 *   ONEOFF_INTRO_COUPON      = <couponId>  (optional, 50% off first-time)
 *
 *   PUBLIC_APP_ORIGIN        = https://book.gmautodetailing.uk (fallback for success/cancel)
 */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
const APP_ORIGIN =
  (process.env.PUBLIC_APP_ORIGIN ||
    process.env.FRONTEND_PUBLIC_URL ||
    "https://book.gmautodetailing.uk").replace(/\/+$/, "");

const PRICE_EXT = (process.env.ONEOFF_EXTERIOR_PRICE || "").trim();
const PRICE_FULL = (process.env.ONEOFF_FULL_PRICE || "").trim();
const INTRO_COUPON = (process.env.ONEOFF_INTRO_COUPON || "").trim();

function priceForService(service_key) {
  if (service_key === "exterior") return PRICE_EXT;
  if (service_key === "full") return PRICE_FULL;
  return null;
}

async function isFirstTimeCustomer(customer) {
  try {
    // Your helper in db.js; treat "first time" as "no prior record"
    return !(await hasExistingCustomer({
      email: customer?.email || "",
      phone: customer?.phone || "",
      street: customer?.street || "",
    }));
  } catch {
    // Fail-open to avoid blocking checkout
    return false;
  }
}

/* ================================================================
 *  Named export #1: createCheckoutSession (used by legacy store.js)
 * ================================================================ */
export async function createCheckoutSession(req, res) {
  try {
    const { customer, service_key, addons = [], origin, slot, first_time } = req.body || {};

    if (!customer?.email || !service_key) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const priceId = priceForService(service_key);
    if (!priceId) {
      return res.status(400).json({ ok: false, error: "invalid_service" });
    }

    // Determine success/cancel base
    let base;
    try { base = new URL(origin || APP_ORIGIN).origin; }
    catch { base = APP_ORIGIN; }

    // Decide coupon application
    let applyCoupon = false;
    if (INTRO_COUPON) {
      // honour explicit flag if FE sends one; else compute server-side
      if (typeof first_time === "boolean") {
        applyCoupon = first_time;
      } else {
        applyCoupon = await isFirstTimeCustomer(customer);
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: customer.email,
      line_items: [{ price: priceId, quantity: 1 }],
      discounts: applyCoupon && INTRO_COUPON ? [{ coupon: INTRO_COUPON }] : undefined,
      success_url: `${base}/?thankyou=1&flow=oneoff&paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?cancel=1`,
      // Minimal metadata useful later if you wire a confirm step
      metadata: {
        app: "gm",
        kind: "oneoff",
        service_key,
        email: (customer.email || "").toLowerCase(),
        slot_start: slot?.start_iso || "",
        addons: (Array.isArray(addons) ? addons.join(",") : ""),
      },
    });

    console.log(`[oneoff] create session for ${service_key} coupon=${applyCoupon ? INTRO_COUPON : "(none)"}`);
    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[oneoff] create-checkout-session failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "session_failed" });
  }
}

/* ================================================================
 *  Confirm endpoint (optional, kept for your existing FE flow)
 *  FE calls this with { session_id } after redirect success.
 * ================================================================ */
async function confirmOneoff(req, res) {
  try {
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ ok: false, error: "missing_session" });

    // You can expand here if you want to create a booking record after payment.
    // const session = await stripe.checkout.sessions.retrieve(session_id);

    return res.json({ ok: true });
  } catch (err) {
    console.error("[oneoff] confirm failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "confirm_failed" });
  }
}

/* ================================================================
 *  Named export #2: stripeWebhook (used by legacy store.js)
 *  Minimal ack so module loads cleanly; expand if you need.
 * ================================================================ */
export async function stripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (err) {
    console.error("[oneoff webhook] bad signature:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const t = event.type;
  // Log interesting events; do not fail the webhook.
  if (t === "checkout.session.completed") {
    const s = event.data.object;
    console.log("[oneoff webhook] checkout.session.completed", s.id);
  } else if (t === "payment_intent.succeeded") {
    console.log("[oneoff webhook] payment_intent.succeeded");
  }
  res.json({ received: true });
}

/* ================================================================
 *  Exported helper to mount routes in the new server.js
 * ================================================================ */
export function mountPayments(app) {
  // Webhook must use RAW body before any JSON middleware (server.js ensures this for memberships;
  // for one-off we can mount here with raw as well, then switch back to JSON for the others).
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);

  // Normal JSON for the rest
  app.post("/api/pay/create-checkout-session", express.json(), createCheckoutSession);
  app.post("/api/pay/confirm", express.json(), confirmOneoff);
}
