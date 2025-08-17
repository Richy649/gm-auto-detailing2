// backend/src/payments.js (ESM)
import Stripe from "stripe";
import { createCalendarEvent } from "./googleCalendar.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const CURRENCY = "gbp";
const FRONTEND_PUBLIC_URL = process.env.FRONTEND_PUBLIC_URL || "http://localhost:5173";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Prices in pence (no need to pre-create Stripe Prices)
const PRICES = {
  exterior: 4000,               // £40
  full: 6000,                   // £60
  standard_membership: 7000,    // £70
  premium_membership: 10000,    // £100
};
const ADDONS = { wax: 1500, polish: 1500 }; // pence

export async function createCheckoutSession(req, res) {
  try {
    const { customer, service_key, addons = [], slot, membershipSlots = [] } = req.body || {};
    if (!customer || !service_key) return res.status(400).json({ ok: false, error: "Missing customer or service_key" });

    const line_items = [
      {
        price_data: {
          currency: CURRENCY,
          product_data: { name: service_key.replace(/_/g, " ") },
          unit_amount: PRICES[service_key] ?? 0,
        },
        quantity: 1,
      },
      ...addons
        .filter((k) => k in ADDONS)
        .map((k) => ({
          price_data: { currency: CURRENCY, product_data: { name: `Addon: ${k}` }, unit_amount: ADDONS[k] },
          quantity: 1,
        })),
    ];

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      metadata: {
        service_key,
        addons: JSON.stringify(addons || []),
        customer: JSON.stringify(customer || {}),
        slot: slot ? JSON.stringify(slot) : "",
        membershipSlots: JSON.stringify(membershipSlots || []),
      },
      success_url: `${FRONTEND_PUBLIC_URL}/?paid=1`,
      cancel_url: `${FRONTEND_PUBLIC_URL}/?cancelled=1`,
    });

    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("createCheckoutSession error:", err);
    res.status(500).json({ ok: false, error: "Failed to create checkout session" });
  }
}

export async function stripeWebhook(req, res) {
  try {
    let event;
    const sig = req.headers["stripe-signature"];

    if (WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, WEBHOOK_SECRET);
    } else {
      // dev fallback
      event = req.body;
    }

    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const md = s.metadata || {};
      const service_key = md.service_key;
      const addons = JSON.parse(md.addons || "[]");
      const customer = JSON.parse(md.customer || "{}");
      const slot = md.slot ? JSON.parse(md.slot) : null;
      const membershipSlots = md.membershipSlots ? JSON.parse(md.membershipSlots) : [];

      const slots = membershipSlots.length ? membershipSlots : (slot ? [slot] : []);
      for (const x of slots) {
        try {
          await createCalendarEvent({
            service_key, addons, customer,
            start_iso: x.start_iso, end_iso: x.end_iso,
          });
        } catch (e) {
          console.error("Calendar insert failed:", e);
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("stripeWebhook error:", err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
}
