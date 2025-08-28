// backend/src/payments.js
import express from "express";
import Stripe from "stripe";
import { hasExistingCustomer, saveBooking } from "./db.js";
import { createCalendarEvents } from "./gcal.js";

/**
 * Payments + Webhooks + Resilience confirm endpoint
 *
 * ENV expected:
 *   STRIPE_SECRET_KEY       = sk_test_... or sk_live_...
 *   STRIPE_WEBHOOK_SECRET   = whsec_... (must match Test vs Live mode)
 *   PUBLIC_FRONTEND_ORIGIN  = https://book.gmautodetailing.uk  (fallback if 'origin' not sent by FE)
 */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FRONTEND_ORIGIN = (process.env.PUBLIC_FRONTEND_ORIGIN || "https://book.gmautodetailing.uk").replace(/\/+$/, "");

const GBP = "gbp";

/** Service catalog (server-authoritative) */
const services = {
  exterior:             { name: "Exterior Detail",                     minutes: 75,  price_cents: 4000 },
  full:                 { name: "Full Detail",                         minutes: 120, price_cents: 6000 },
  standard_membership:  { name: "Standard Membership (2 Exterior)",    minutes: 75,  price_cents: 7000 },
  premium_membership:   { name: "Premium Membership (2 Full)",         minutes: 120, price_cents: 10000 },
};

const addons = {
  wax:    { name: "Full Body Wax", price_cents: 1000 },
  polish: { name: "Hand Polish",   price_cents: 2250 },
};

/** Small helpers */
function cleanStr(v) { return (String(v || "").trim()); }
function normalizeEmail(e) { return cleanStr(e).toLowerCase(); }
function normalizeStreet(s) { return cleanStr(s).toLowerCase(); }

/** Build line items w/ first-time 50% off on service ONLY (addons full price) */
async function buildLineItemsAndFirstTime(customer, service_key, addonKeys) {
  const firstTime = !(await hasExistingCustomer({
    email: normalizeEmail(customer?.email),
    phone: cleanStr(customer?.phone),
    street: normalizeStreet(customer?.street),
  }));

  const svc = services[service_key];
  if (!svc) throw new Error("invalid_service");

  const line_items = [];
  const svcAmount = Math.round(svc.price_cents * (firstTime ? 0.5 : 1));
  line_items.push({
    price_data: {
      currency: GBP,
      product_data: { name: svc.name },
      unit_amount: svcAmount,
    },
    quantity: 1,
  });

  for (const k of addonKeys || []) {
    const ad = addons[k];
    if (!ad) continue;
    line_items.push({
      price_data: {
        currency: GBP,
        product_data: { name: ad.name },
        unit_amount: ad.price_cents,
      },
      quantity: 1,
    });
  }

  return { firstTime, line_items };
}

/** Persist bookings and sync Google Calendar (idempotent on Calendar by event id) */
async function persistAndSync(sessionId, payload) {
  const svc = services[payload.service_key] || { name: payload.service_key || "Service" };
  const itemsForCalendar = [];

  for (const sl of (payload.slots || [])) {
    // Save to DB (writes legacy start_iso/end_iso and backfills timestamptz)
    try {
      await saveBooking({
        stripe_session_id: sessionId,
        service_key: payload.service_key,
        addons: payload.addons || [],
        start_iso: sl.start_iso,
        end_iso: sl.end_iso,
        customer: payload.customer || {},
        has_tap: !!payload.has_tap,
      });
    } catch (e) {
      console.warn("[saveBooking] failed", e?.message || e);
      // continue; Calendar sync remains idempotent, but availability mask depends on DB save
    }

    // Prepare Calendar item
    const desc = [
      `Name: ${payload.customer?.name || ""}`,
      `Phone: ${payload.customer?.phone || ""}`,
      `Email: ${payload.customer?.email || ""}`,
      `Address: ${payload.customer?.street || ""}, ${payload.customer?.postcode || ""}`,
      `Outhouse tap: ${payload.has_tap ? "Yes" : "No"}`,
      (payload.addons?.length ? `Add-ons: ${payload.addons.map(k => (addons[k]?.name || k)).join(", ")}` : null),
      `Stripe session: ${sessionId}`,
    ].filter(Boolean).join("\n");

    itemsForCalendar.push({
      start_iso: sl.start_iso,
      end_iso: sl.end_iso,
      summary: `GM Auto Detailing — ${svc.name}`,
      description: desc,
      location: `${payload.customer?.street || ""}, ${payload.customer?.postcode || ""}`.trim(),
    });
  }

  try {
    await createCalendarEvents(sessionId, itemsForCalendar);
  } catch (e) {
    console.warn("[gcal] create events failed", e?.message || e);
  }
}

export function mountPayments(app) {
  /**
   * Create Checkout Session
   * Body: { customer, has_tap, service_key, addons:[], slot?, membershipSlots?:[], origin? }
   */
  app.post("/api/pay/create-checkout-session", express.json(), async (req, res) => {
    try {
      const { customer, has_tap, service_key, addons: addonKeys = [], slot, membershipSlots = [], origin } = req.body || {};
      if (!customer || !service_key) return res.status(400).json({ ok: false, error: "missing_fields" });

      // Build price lines + first-time flag (server-side authoritative)
      const { firstTime, line_items } = await buildLineItemsAndFirstTime(customer, service_key, addonKeys);

      // Serialize minimal payload for webhook / confirm endpoint
      const payload = {
        service_key,
        addons: addonKeys,
        has_tap: !!has_tap,
        first_time: !!firstTime, // informational
        customer: {
          name: cleanStr(customer.name),
          email: normalizeEmail(customer.email),
          phone: cleanStr(customer.phone),
          street: cleanStr(customer.street),
          postcode: cleanStr(customer.postcode),
        },
        slots: (service_key.includes("membership") ? (membershipSlots || []) : (slot ? [slot] : [])),
      };

      const sess = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items,
        // include session id in success url so FE can call /api/pay/confirm if webhook lags
        success_url: `${(origin || FRONTEND_ORIGIN)}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: (origin || FRONTEND_ORIGIN),
        metadata: { payload: JSON.stringify(payload) },
      });

      if (!sess?.url) return res.status(500).json({ ok: false, error: "no_checkout_url" });
      return res.json({ ok: true, url: sess.url });
    } catch (e) {
      console.error("[checkout] error", e?.message || e);
      return res.status(500).json({ ok: false, error: "checkout_failed" });
    }
  });

  /**
   * Stripe Webhook (must use raw body; keep this route BEFORE any global express.json())
   * Event handled: checkout.session.completed
   */
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } catch (err) {
      console.warn("[webhook] signature error", err?.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      let payload = {};
      try { payload = JSON.parse(session.metadata?.payload || "{}"); } catch { payload = {}; }

      try {
        await persistAndSync(session.id, payload);
      } catch (e) {
        console.warn("[webhook persist] failed", e?.message || e);
      }
    }

    res.json({ received: true });
  });

  /**
   * Resilience endpoint:
   * If webhook is delayed/dropped, FE calls this after success redirect with session_id.
   * Body: { session_id }
   */
  app.post("/api/pay/confirm", express.json(), async (req, res) => {
    try {
      const { session_id } = req.body || {};
      if (!session_id) return res.status(400).json({ ok: false, error: "missing_session_id" });

      const sess = await stripe.checkout.sessions.retrieve(session_id);
      if (!sess || (sess.payment_status !== "paid" && sess.status !== "complete")) {
        return res.status(409).json({ ok: false, error: "session_not_paid" });
      }

      let payload = {};
      try { payload = JSON.parse(sess.metadata?.payload || "{}"); } catch { payload = {}; }
      if (!payload?.service_key || !Array.isArray(payload?.slots)) {
        return res.status(400).json({ ok: false, error: "invalid_session_payload" });
      }

      await persistAndSync(sess.id, payload);
      return res.json({ ok: true });
    } catch (e) {
      console.warn("[confirm] failed", e?.message || e);
      return res.status(500).json({ ok: false, error: "confirm_failed" });
    }
  });
}
