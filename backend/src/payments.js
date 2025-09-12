// backend/src/payments.js
import express from "express";
import Stripe from "stripe";
import { pool, saveBooking } from "./db.js";
import { createCalendarEvents } from "./gcal.js";

/**
 * One-off payments:
 *   - Create Checkout Session
 *   - Webhook to persist booking + create calendar event
 *   - Resilience confirm endpoint
 *
 * ENV expected:
 *   STRIPE_SECRET_KEY         = sk_test_... or sk_live_...
 *   STRIPE_WEBHOOK_SECRET     = whsec_...
 *   FRONTEND_PUBLIC_URL       = https://book.gmautodetailing.uk
 *   (fallbacks tried: PUBLIC_APP_ORIGIN, PUBLIC_FRONTEND_ORIGIN)
 */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

/* ---------------------------- Service Catalog ---------------------------- */
/** IMPORTANT: keep these in sync with your public pricing */
const services = {
  exterior:            { name: "Exterior Detail",                    minutes: 75,  price_cents: 4000 },
  full:                { name: "Full Detail",                        minutes: 120, price_cents: 6000 },
  // memberships are NOT charged here; subscriptions are handled in memberships.js
};

const addons = {
  wax:    { name: "Full Body Wax", price_cents: 1000 },
  polish: { name: "Hand Polish",   price_cents: 2250 },
};

/* ------------------------------- Utilities ------------------------------- */
function sanitize(s) { return (s ?? "").toString().replace(/[\u0000-\u001F\u007F\uFFFF]/g, "").trim(); }
function normEmail(s) { return sanitize(s).toLowerCase(); }
function normStreet(s) { return sanitize(s).toLowerCase().replace(/[^a-z0-9]+/g, ""); }

function resolveFrontendOrigin() {
  const cand =
    process.env.FRONTEND_PUBLIC_URL ||
    process.env.PUBLIC_APP_ORIGIN ||
    process.env.PUBLIC_FRONTEND_ORIGIN ||
    "https://book.gmautodetailing.uk";
  try { return new URL(cand).origin; } catch { return "https://book.gmautodetailing.uk"; }
}
const FRONTEND_ORIGIN = resolveFrontendOrigin();

/**
 * Server-side first-time check (email OR phone OR normalized street has been seen before).
 * Mirrors your “first-time” UI logic without needing extra helpers.
 */
async function isFirstTimeCustomer({ email, phone, street }) {
  const emailNorm = normEmail(email);
  const phoneNorm = sanitize(phone);
  const streetNorm = normStreet(street);

  // If nothing to check, treat as NOT first-time (no discount) to be safe.
  if (!emailNorm && !phoneNorm && !streetNorm) return false;

  const r = await pool.query(
    `
    SELECT 1
      FROM public.users
     WHERE ($1 <> '' AND lower(email) = $1)
        OR ($2 <> '' AND phone = $2)
        OR ($3 <> '' AND lower(regexp_replace(COALESCE(street,''),'[^a-z0-9]+','', 'g')) = $3)
     LIMIT 1
    `,
    [emailNorm, phoneNorm, streetNorm]
  );
  // If we found a match, they are NOT first-time
  return r.rowCount === 0;
}

/**
 * Build Stripe line_items with first-time discount applied to the base service only.
 */
async function buildLineItems(customer, service_key, addonKeys) {
  const svc = services[service_key];
  if (!svc) throw new Error("invalid_service");

  const firstTime = await isFirstTimeCustomer({
    email: customer?.email,
    phone: customer?.phone,
    street: customer?.street,
  });

  const line_items = [];
  const svcAmount = Math.round(svc.price_cents * (firstTime ? 0.5 : 1));
  line_items.push({
    price_data: {
      currency: "gbp",
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
        currency: "gbp",
        product_data: { name: ad.name },
        unit_amount: ad.price_cents,
      },
      quantity: 1,
    });
  }

  return { line_items, firstTime };
}

/* -------------------------- Persistence + GCal -------------------------- */
async function persistAndSync(sessionId, payload) {
  const svcName = services[payload.service_key]?.name || payload.service_key || "Service";

  const itemsForCalendar = [];
  for (const sl of (payload.slots || [])) {
    // Save booking row
    await saveBooking({
      stripe_session_id: sessionId,
      service_key: payload.service_key,
      addons: payload.addons || [],
      start_iso: sl.start_iso,
      end_iso: sl.end_iso,
      customer: payload.customer || {},
      has_tap: !!payload.has_tap,
    });

    // Prepare calendar item
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
      summary: `GM Auto Detailing — ${svcName}`,
      description: desc,
      location: `${payload.customer?.street || ""}, ${payload.customer?.postcode || ""}`.trim(),
    });
  }

  // Best-effort calendar creation
  await createCalendarEvents(sessionId, itemsForCalendar);
}

/* --------------------------------- Mount -------------------------------- */
export function mountPayments(app) {
  /**
   * Create Checkout Session (one-off)
   * Body: { customer, has_tap, service_key, addons:[], slot, origin? }
   */
  app.post("/api/pay/create-checkout-session", express.json(), async (req, res) => {
    try {
      const { customer, has_tap, service_key, addons: addonKeys = [], slot, origin } = req.body || {};
      if (!customer || !service_key || !slot?.start_iso || !slot?.end_iso) {
        return res.status(400).json({ ok: false, error: "Please select a time and complete your details." });
      }

      const { line_items } = await buildLineItems(customer, service_key, addonKeys);

      const payload = {
        service_key,
        addons: addonKeys,
        has_tap: !!has_tap,
        customer: {
          name: sanitize(customer.name),
          email: normEmail(customer.email),
          phone: sanitize(customer.phone),
          street: sanitize(customer.street),
          postcode: sanitize(customer.postcode),
        },
        slots: [slot],
      };

      const successBase = (origin ? new URL(origin).origin : FRONTEND_ORIGIN);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items,
        success_url: `${successBase}/?paid=1&flow=oneoff&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: successBase,
        metadata: { payload: JSON.stringify(payload) },
      });

      if (!session?.url) return res.status(500).json({ ok: false, error: "Unable to start checkout." });
      return res.json({ ok: true, url: session.url });
    } catch (e) {
      console.error("[pay/create-checkout-session] error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Payment failed to initialise" });
    }
  });

  /**
   * One-off webhook (MUST remain raw)
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
        try { payload = JSON.parse(session?.metadata?.payload || "{}"); } catch { payload = {}; }
        // Validate minimal payload
        if (payload?.service_key && Array.isArray(payload?.slots) && payload.slots.length) {
          await persistAndSync(sessionId, payload);
        } else {
          console.warn("[webhook] session missing payload or slots");
        }
      } catch (e) {
        console.warn("[webhook] persist failed:", e?.message || e);
      }
    }

    res.json({ received: true });
  });

  /**
   * Confirm endpoint — FE calls after success redirect to ensure persistence
   */
  app.post("/api/pay/confirm", express.json(), async (req, res) => {
    try {
      const { session_id } = req.body || {};
      if (!session_id) return res.status(400).json({ ok: false, error: "Missing session_id" });

      const sess = await stripe.checkout.sessions.retrieve(session_id);
      if (!sess?.id) return res.status(404).json({ ok: false, error: "Session not found." });

      let payload = {};
      try { payload = JSON.parse(sess.metadata?.payload || "{}"); } catch { payload = {}; }
      if (!payload?.service_key || !Array.isArray(payload?.slots) || !payload.slots.length) {
        return res.status(400).json({ ok: false, error: "Invalid session payload." });
      }

      await persistAndSync(sess.id, payload);
      return res.json({ ok: true });
    } catch (e) {
      console.warn("[pay/confirm] failed:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Confirm failed." });
    }
  });
}
