// backend/src/payments.js
import Stripe from "stripe";
import { getConfig } from "./config.js";
import {
  initStore, cleanupExpiredHolds, isSlotFree,
  newHoldKey, addHold, attachSessionToHolds, releaseHoldsByKey,
  promoteHoldsToBookingsBySession
} from "./store.js";

let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY missing");
  _stripe = new Stripe(key, { apiVersion: "2024-06-20" });
  return _stripe;
}

function frontendURLFrom(req) {
  const env = (process.env.FRONTEND_PUBLIC_URL || "").replace(/\/+$/, "");
  if (env) return env;
  const fromBody = ((req.body && req.body.origin) || "").replace(/\/+$/, "");
  if (fromBody && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(fromBody)) return fromBody;
  return null;
}

const HOLD_MINUTES = 15;

export async function createCheckoutSession(req, res) {
  try {
    await initStore();
    await cleanupExpiredHolds();

    const cfg = getConfig();
    const { customer, service_key, addons = [], slot, membershipSlots = [] } = req.body || {};
    if (!customer || !service_key) return res.status(400).json({ ok: false, error: "Missing customer or service_key" });

    const svc = cfg.services?.[service_key];
    if (!svc) return res.status(400).json({ ok: false, error: "Unknown service_key" });

    const slots = membershipSlots?.length ? membershipSlots : (slot ? [slot] : []);
    if (!slots.length) return res.status(400).json({ ok:false, error: "No time selected" });

    if (service_key.includes("membership")) {
      const days = new Set(slots.map(s => (new Date(s.start_iso)).toISOString().slice(0,10)));
      if (days.size !== slots.length) return res.status(400).json({ ok:false, error: "Membership visits must be on different days" });
    }

    const hold_key = newHoldKey();
    for (const s of slots) {
      const free = await isSlotFree(s.start_iso, s.end_iso);
      if (!free) return res.status(409).json({ ok:false, error: "Sorry, that time was just taken. Please choose another slot." });
      const r = await addHold({ hold_key, service_key, start_iso: s.start_iso, end_iso: s.end_iso, customer });
      if (!r.ok) return res.status(409).json({ ok:false, error: "Another user just reserved that time. Pick a different slot." });
    }

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

    const origin = frontendURLFrom(req);
    if (!origin) {
      await releaseHoldsByKey(hold_key);
      return res.status(500).json({ ok:false, error: "Frontend URL not configured" });
    }

    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      line_items,
      metadata: {
        service_key,
        addons: JSON.stringify(addons || []),
        customer: JSON.stringify(customer || {}),
        hold_key,
        hold_expires_minutes: String(HOLD_MINUTES)
      },
      success_url: `${origin}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?cancelled=1`,
    });

    await attachSessionToHolds(hold_key, session.id);
    res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error("[createCheckoutSession] error:", e);
    return res.status(500).json({ ok:false, error: e.message || "Checkout failed" });
  }
}

export async function stripeWebhook(req, res) {
  try {
    await initStore();
    const sig = req.headers["stripe-signature"];
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event = null;
    if (whSecret && req.rawBody) {
      event = stripe().webhooks.constructEvent(req.rawBody, sig, whSecret);
    } else {
      event = req.body; // fallback
      console.warn("[stripeWebhook] Missing STRIPE_WEBHOOK_SECRET or rawBody; not verifying signature.");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const md = session.metadata || {};
      const metadata = {
        service_key: md.service_key,
        addons: JSON.parse(md.addons || "[]"),
        customer: JSON.parse(md.customer || "{}")
      };
      await promoteHoldsToBookingsBySession(session.id, metadata);
      console.log("[stripeWebhook] bookings inserted for session", session.id);
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("[stripeWebhook] error:", e);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
}
