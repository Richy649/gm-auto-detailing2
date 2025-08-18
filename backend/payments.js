// backend/payments.js (ESM)
import Stripe from "stripe";
import { getConfig } from "./config.js";
import { isSlotFree } from "./availability.js";
import { createCalendarEvent } from "./googleCalendar.js"; // safe if your file already handles no config

let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY missing");
  _stripe = new Stripe(key, { apiVersion: "2024-06-20" });
  return _stripe;
}

function originFromEnv() {
  const envUrl = (process.env.FRONTEND_PUBLIC_URL || "").trim();
  return envUrl ? envUrl.replace(/\/+$/,"") : null;
}

export async function createCheckoutSession(req, res) {
  try {
    const cfg = getConfig();
    const { customer, service_key, addons = [], slot, membershipSlots = [] } = req.body || {};
    if (!customer || !service_key) return res.status(400).json({ ok: false, error: "Missing customer or service_key" });

    const svc = cfg.services?.[service_key];
    if (!svc) return res.status(400).json({ ok: false, error: "Unknown service_key" });

    // --- Revalidate times just before creating Checkout ---
    const slots = membershipSlots?.length ? membershipSlots : (slot ? [slot] : []);
    if (!slots.length) return res.status(400).json({ ok:false, error: "No time selected" });

    // For memberships ensure different days
    if (service_key.includes("membership")) {
      const dayKeys = new Set(slots.map(s => (new Date(s.start_iso)).toISOString().slice(0,10)));
      if (dayKeys.size !== slots.length) return res.status(400).json({ ok:false, error: "Membership visits must be on different days" });
    }

    for (const s of slots) {
      const free = await isSlotFree(service_key, s.start_iso, s.end_iso);
      if (!free) return res.status(409).json({ ok:false, error: "Sorry, that time was just taken. Please choose another slot." });
    }

    // --- Prices from config only ---
    const currency = cfg.currency || "gbp";
    const basePrice = cfg.services[service_key].price;
    const line_items = [
      {
        price_data: {
          currency,
          product_data: { name: cfg.services[service_key].name },
          unit_amount: Math.round(basePrice * 100),
        },
        quantity: 1,
      },
      ...addons
        .filter(a => cfg.addons[a])
        .map(a => ({
          price_data: {
            currency,
            product_data: { name: `Addon: ${cfg.addons[a].name}` },
            unit_amount: Math.round(cfg.addons[a].price * 100),
          },
          quantity: 1,
        })),
    ];

    const metadata = {
      service_key,
      addons: JSON.stringify(addons || []),
      customer: JSON.stringify(customer || {}),
      slot: slots.length === 1 ? JSON.stringify(slots[0]) : "",
      membershipSlots: slots.length > 1 ? JSON.stringify(slots) : "",
    };

    const successOrigin = originFromEnv();
    if (!successOrigin) return res.status(500).json({ ok:false, error: "FRONTEND_PUBLIC_URL is not set in backend env." });

    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      line_items,
      metadata,
      success_url: `${successOrigin}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${successOrigin}/?cancelled=1`,
    });

    return res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error("[createCheckoutSession] error:", e);
    return res.status(500).json({ ok:false, error: e.message || "Checkout failed" });
  }
}

export async function stripeWebhook(req, res) {
  try {
    const sig = req.headers["stripe-signature"];
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event = null;
    if (whSecret && req.rawBody) {
      event = stripe().webhooks.constructEvent(req.rawBody, sig, whSecret);
    } else {
      // Fallback (not recommended for prod)
      event = req.body;
      console.warn("[stripeWebhook] Missing STRIPE_WEBHOOK_SECRET or rawBody, skipping verify.");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const md = session.metadata || {};
      const service_key = md.service_key;
      const addons = JSON.parse(md.addons || "[]");
      const customer = JSON.parse(md.customer || "{}");
      const slot = md.slot ? JSON.parse(md.slot) : null;
      const membershipSlots = md.membershipSlots ? JSON.parse(md.membershipSlots) : [];

      const finalSlots = membershipSlots.length ? membershipSlots : (slot ? [slot] : []);
      for (const s of finalSlots) {
        try {
          // if you have Google Calendar set up, this will insert the event
          await createCalendarEvent({
            service_key, addons, customer,
            start_iso: s.start_iso, end_iso: s.end_iso
          });
        } catch (err) {
          console.error("[stripeWebhook] calendar insert failed:", err);
        }
      }
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("[stripeWebhook] error:", e);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
}
