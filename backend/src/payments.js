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

// Resolve a safe frontend origin from several envs, then fallback.
function resolveFrontendOrigin() {
  const cand =
    process.env.PUBLIC_FRONTEND_ORIGIN ||
    process.env.FRONTEND_PUBLIC_URL ||
    process.env.PUBLIC_APP_ORIGIN ||
    "https://book.gmautodetailing.uk";
  try {
    const u = new URL(cand);
    return `${u.origin}`;
  } catch {
    return "https://book.gmautodetailing.uk";
  }
}
const FRONTEND_ORIGIN = resolveFrontendOrigin();

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

/* ---------------------------- Normalizers ---------------------------- */
function cleanStr(s) { return (s ?? "").toString().replace(/[\u0000-\u001F\u007F\uFFFF]/g, "").trim(); }
function normalizeEmail(s) { return cleanStr(s).toLowerCase(); }
function normalizeStreet(s) { return cleanStr(s).toLowerCase().replace(/[^a-z0-9]+/g, ""); }

/* -------------------------- Price composition ------------------------ */
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

  return { line_items, firstTime };
}

/* ------------------------------- Mount ------------------------------- */
export function mountPayments(app) {
  /**
   * Create Checkout Session
   * Body: { customer, has_tap, service_key, addons:[], slot?, membershipSlots?:[], origin? }
   */
  app.post("/api/pay/create-checkout-session", express.json(), async (req, res) => {
    try {
      const { customer, has_tap, service_key, addons: addonKeys = [], slot, membershipSlots = [], origin } = req.body || {};
      if (!customer || !service_key) return res.status(400).json({ ok: false, error: "Please fill out all required fields." });

      // Build price lines + first-time flag (server-side authoritative)
      const { line_items } = await buildLineItemsAndFirstTime(customer, service_key, addonKeys);

      // Serialize minimal payload for webhook / confirm endpoint
      const payload = {
        service_key,
        addons: addonKeys,
        has_tap: !!has_tap,
        customer: {
          name: cleanStr(customer.name),
          email: normalizeEmail(customer.email),
          phone: cleanStr(customer.phone),
          street: cleanStr(customer.street),
          postcode: cleanStr(customer.postcode),
        },
        slots: (service_key.includes("membership") ? (membershipSlots || []) : (slot ? [slot] : [])),
      };

      const successBase = (origin || FRONTEND_ORIGIN).replace(/\/+$/, "");
      const sess = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items,
        // flow=oneoff so the frontend knows which Thank You variant to show
        success_url: `${successBase}?paid=1&flow=oneoff&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: (successBase),
        metadata: { payload: JSON.stringify(payload) },
      });

      if (!sess?.url) return res.status(500).json({ ok: false, error: "Unable to start checkout." });
      return res.json({ ok: true, url: sess.url });
    } catch (e) {
      console.error("[checkout] error", e?.message || e);
      return res.status(500).json({ ok: false, error: "Payment initialisation failed." });
    }
  });

  /**
   * Webhook: persist & create calendar events after Stripe confirms the session.
   */
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET);
    } catch (err) {
      console.error("[webhook] signature verification failed:", err?.message || err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const sessionId = session?.id;
      try {
        let payload = {};
        try { payload = JSON.parse(session.metadata?.payload || "{}"); } catch { payload = {}; }
        await persistAndSync(sessionId, payload);
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
      if (!session_id) return res.status(400).json({ ok: false, error: "Missing session_id" });

      const sess = await stripe.checkout.sessions.retrieve(session_id);
      if (!sess?.id) return res.status(404).json({ ok: false, error: "Session not found." });

      let payload = {};
      try { payload = JSON.parse(sess.metadata?.payload || "{}"); } catch { payload = {}; }
      if (!payload?.service_key || !Array.isArray(payload?.slots)) {
        return res.status(400).json({ ok: false, error: "Invalid session payload." });
      }

      await persistAndSync(sess.id, payload);
      return res.json({ ok: true });
    } catch (e) {
      console.warn("[confirm] failed", e?.message || e);
      return res.status(500).json({ ok: false, error: "Confirm failed." });
    }
  });
}

/* ------------------------- Persistence + GCal ------------------------ */
async function persistAndSync(sessionId, payload) {
  const svc = services[payload.service_key] || { name: payload.service_key || "Service" };
  const itemsForCalendar = [];

  for (const sl of (payload.slots || [])) {
    // Save to DB
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
    }

    // Build calendar item
    const desc = [
      `Name: ${payload.customer?.name || ""}`,
      `Phone: ${payload.customer?.phone || ""}`,
      `Email: ${payload.customer?.email || ""}`,
      `Address: ${payload.customer?.street || ""}, ${payload.customer?.postcode || ""}`,
      `Outhouse tap: ${payload.has_tap ? "Yes" : "No"}`,
      (payload.addons?.length ? `Add-ons: ${payload.addons.join(", ")}` : null),
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
