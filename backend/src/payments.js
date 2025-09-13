// backend/src/payments.js
import express from "express";
import Stripe from "stripe";
import { hasExistingCustomer } from "./db.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const APP_ORIGIN =
  (process.env.PUBLIC_APP_ORIGIN ||
    process.env.FRONTEND_PUBLIC_URL ||
    "https://book.gmautodetailing.uk").replace(/\/+$/, "");

const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

const PRICE_EXT  = (process.env.ONEOFF_EXTERIOR_PRICE || "").trim();
const PRICE_FULL = (process.env.ONEOFF_FULL_PRICE || "").trim();
const INTRO_COUPON = (process.env.ONEOFF_INTRO_COUPON || "").trim();

function priceForService(service_key) {
  if (service_key === "exterior") return PRICE_EXT;
  if (service_key === "full")     return PRICE_FULL;
  return null;
}

async function isFirstTimeCustomer(customer) {
  try {
    return !(await hasExistingCustomer({
      email: (customer?.email || "").toLowerCase(),
      phone: (customer?.phone || "").trim(),
      street: (customer?.street || "").trim(),
    }));
  } catch {
    return false;
  }
}

/* ===== Named export (legacy) ===== */
export async function createCheckoutSession(req, res) {
  try {
    const { customer, service_key, addons = [], origin, slot, first_time } = req.body || {};
    if (!customer?.email || !service_key) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const priceId = priceForService(service_key);
    if (!priceId) return res.status(400).json({ ok: false, error: "invalid_service" });

    let base;
    try { base = new URL(origin || APP_ORIGIN).origin; }
    catch { base = APP_ORIGIN; }

    let applyCoupon = false;
    if (INTRO_COUPON) {
      if (typeof first_time === "boolean") applyCoupon = first_time;
      else applyCoupon = await isFirstTimeCustomer(customer);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: customer.email,
      line_items: [{ price: priceId, quantity: 1 }],
      discounts: applyCoupon && INTRO_COUPON ? [{ coupon: INTRO_COUPON }] : undefined,
      success_url: `${base}/?thankyou=1&flow=oneoff&paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?cancel=1`,
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

/* ===== Named export (legacy) ===== */
export async function stripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (err) {
    console.error("[oneoff webhook] bad signature:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const t = event.type;
  if (t === "checkout.session.completed") {
    const s = event.data.object;
    console.log("[oneoff webhook] checkout.session.completed", s.id);
  } else if (t === "payment_intent.succeeded") {
    console.log("[oneoff webhook] payment_intent.succeeded");
  }
  res.json({ received: true });
}

/* ===== New split mounting ===== */
export function mountPaymentsWebhook(app) {
  // Mount webhook with RAW body BEFORE express.json()
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);
}

export function mountPaymentsRoutes(app) {
  // Mount normal JSON routes AFTER express.json()
  app.post("/api/pay/create-checkout-session", express.json(), createCheckoutSession);
  app.post("/api/pay/confirm", express.json(), async (req, res) => {
    try {
      const { session_id } = req.body || {};
      if (!session_id) return res.status(400).json({ ok: false, error: "missing_session" });
      // You can fetch the session here if you want confirmation logic.
      return res.json({ ok: true });
    } catch (err) {
      console.error("[oneoff] confirm failed:", err?.message || err);
      return res.status(500).json({ ok: false, error: "confirm_failed" });
    }
  });
}

/* ===== Backward compatibility (if anything still calls mountPayments) ===== */
export function mountPayments(app) {
  mountPaymentsWebhook(app);
  // The caller must ensure express.json() runs before routes, or pass through as done in server.js
  mountPaymentsRoutes(app);
}
