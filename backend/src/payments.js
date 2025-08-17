// ESM module
import Stripe from "stripe";
import { createCalendarEvent } from "./googleCalendar.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const CURRENCY = "gbp";
const FRONTEND_PUBLIC_URL = process.env.FRONTEND_PUBLIC_URL || "http://localhost:5173";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Map your service keys to prices (in pence)
const PRICES = {
  exterior: 4000,               // £40
  full: 6000,                   // £60
  standard_membership: 7000,    // £70
  premium_membership: 10000,    // £100
};
// Optional add-ons (pence). They do NOT affect time.
const ADDONS = { wax: 1500, polish: 1500 };

export async function createCheckoutSession(req, res) {
  try {
    const { customer, service_key, addons = [], slot, membershipSlots = [] } = req.body || {};
    if (!customer || !service_key) {
      return res.status(400).json({ ok: false, error: "Missing customer or service_key" });
    }

    // Build line items dynamically (no pre-created Stripe prices needed)
    const line_items = [];

    // Base product
    line_items.push({
      price_data: {
        currency: CURRENCY,
        product_data: { name: service_key.replace(/_/g, " ") },
        unit_amount: PRICES[service_key] ?? 0,
      },
      quantity: 1,
    });

    // Add-ons (price only; time logic is elsewhere)
    addons.forEach((k) => {
      if (k in ADDONS) {
        line_items.push({
          price_data: {
            currency: CURRENCY,
            product_data: { name: `Addon: ${k}` },
            unit_amount: ADDONS[k],
          },
          quantity: 1,
        });
      }
    });

    // Put all booking data in metadata so webhook can create the calendar event
    const metadata = {
      service_key,
      addons: JSON.stringify(addons || []),
      customer: JSON.stringify(customer || {}),
      slot: slot ? JSON.stringify(slot) : "",
      membershipSlots: JSON.stringify(membershipSlots || []),
    };

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      metadata,
      success_url: `${FRONTEND_PUBLIC_URL}/?paid=1`,
      cancel_url: `${FRONTEND_PUBLIC_URL}/?cancelled=1`,
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("createCheckoutSession error:", err);
    return res.status(500).json({ ok: false, error: "Failed to create checkout session" });
  }
}

// Stripe webhook: confirm payment → create Google Calendar event(s)
export async function stripeWebhook(req, res) {
  try {
    const sig = req.headers["stripe-signature"];
    let event;

    if (!WEBHOOK_SECRET) {
      // Unsafe parse (dev only)
      event = req.body;
    } else {
      const raw = req.rawBody; // set by server.js (express.raw)
      event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const md = session.metadata || {};

      const service_key = md.service_key;
      const addons = JSON.parse(md.addons || "[]");
      const customer = JSON.parse(md.customer || "{}");
      const slot = md.slot ? JSON.parse(md.slot) : null;
      const membershipSlots = md.membershipSlots ? JSON.parse(md.membershipSlots) : [];

      // Create Calendar events (membership may have 1–2 dates)
      const slots = membershipSlots.length ? membershipSlots : (slot ? [slot] : []);
      for (const s of slots) {
        try {
          await createCalendarEvent({
            service_key,
            addons,
            customer,
            start_iso: s.start_iso,
            end_iso: s.end_iso,
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
