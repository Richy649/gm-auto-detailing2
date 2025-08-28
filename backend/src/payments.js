// backend/src/payments.js
import express from "express";
import Stripe from "stripe";
import { hasExistingCustomer, saveBooking } from "./db.js";
import { createCalendarEvents } from "./gcal.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FRONTEND_ORIGIN = process.env.PUBLIC_FRONTEND_ORIGIN || "https://book.gmautodetailing.uk";

const GBP = "gbp";
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

export function mountPayments(app) {
  /* Create Checkout Session */
  app.post("/api/pay/create-checkout-session", express.json(), async (req, res) => {
    try {
      const { customer, has_tap, service_key, addons: addonKeys = [], slot, membershipSlots = [], origin } = req.body || {};
      if (!customer || !service_key) return res.status(400).json({ ok: false, error: "missing_fields" });

      const svc = services[service_key];
      if (!svc) return res.status(400).json({ ok: false, error: "invalid_service" });

      // Server-side first-time check (email OR phone OR street)
      const firstTime = !(await hasExistingCustomer({
        email: (customer.email || "").toLowerCase(),
        phone: customer.phone || "",
        street: (customer.street || "").toLowerCase(),
      }));

      const line_items = [];

      // Service (50% off if first-time; add-ons are not discounted)
      const svcAmount = Math.round(svc.price_cents * (firstTime ? 0.5 : 1));
      line_items.push({
        price_data: {
          currency: GBP,
          product_data: { name: services[service_key].name },
          unit_amount: svcAmount,
        },
        quantity: 1,
      });

      // Add-ons
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

      // Minimal payload for webhook (idempotent + human-friendly)
      const payload = {
        service_key,
        addons: addonKeys,
        has_tap: !!has_tap,
        customer: {
          name: customer.name || "",
          email: (customer.email || "").toLowerCase(),
          phone: customer.phone || "",
          street: customer.street || "",
          postcode: customer.postcode || "",
        },
        slots: (service_key.includes("membership") ? membershipSlots : (slot ? [slot] : [])) || [],
      };

      const sess = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items,
        success_url: `${(origin || FRONTEND_ORIGIN).replace(/\/+$/,"")}?paid=1`,
        cancel_url: (origin || FRONTEND_ORIGIN),
        metadata: { payload: JSON.stringify(payload) },
      });

      return res.json({ ok: true, url: sess.url });
    } catch (e) {
      console.error("[checkout] error", e?.message || e);
      return res.status(500).json({ ok: false, error: "checkout_failed" });
    }
  });

  /* Stripe webhook (raw body) */
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
      let data = {};
      try { data = JSON.parse(session.metadata?.payload || "{}"); } catch { data = {}; }

      // Build calendar items + persist to DB
      const svc = services[data.service_key] || services.exterior;
      const itemsForCalendar = [];

      for (const sl of data.slots || []) {
        // Save booking (idempotency via stripe_session_id uniqueness implied; if duplicated, DB will just have duplicates — calendar insert uses deterministic id to avoid dup events)
        try {
          await saveBooking({
            stripe_session_id: session.id,
            service_key: data.service_key,
            addons: data.addons || [],
            start_iso: sl.start_iso,
            end_iso: sl.end_iso,
            customer: data.customer || {},
            has_tap: !!data.has_tap,
          });
        } catch (e) {
          console.warn("[saveBooking] failed", e?.message || e);
        }

        const summary = `GM Auto Detailing — ${svc.name}`;
        const desc = [
          `Name: ${data.customer?.name || ""}`,
          `Phone: ${data.customer?.phone || ""}`,
          `Email: ${data.customer?.email || ""}`,
          `Address: ${data.customer?.street || ""}, ${data.customer?.postcode || ""}`,
          `Outhouse tap: ${data.has_tap ? "Yes" : "No"}`,
          (data.addons?.length ? `Add-ons: ${data.addons.map(k => (addons[k]?.name || k)).join(", ")}` : null),
          `Stripe session: ${session.id}`,
        ].filter(Boolean).join("\n");

        itemsForCalendar.push({
          start_iso: sl.start_iso,
          end_iso: sl.end_iso,
          summary,
          description: desc,
          location: `${data.customer?.street || ""}, ${data.customer?.postcode || ""}`.trim(),
        });
      }

      try {
        await createCalendarEvents(session.id, itemsForCalendar);
      } catch (e) {
        console.warn("[gcal] create events failed", e?.message || e);
      }
    }

    res.json({ received: true });
  });
}
