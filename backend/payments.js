// backend/payments.js (ESM)
import Stripe from "stripe";
import { createCalendarEvent } from "./googleCalendar.js";

/* ---------- Prices & settings ---------- */
const CURRENCY = "gbp";

// Amounts in pence
const PRICES = {
  exterior: 4000,               // £40
  full: 6000,                   // £60
  standard_membership: 7000,    // £70
  premium_membership: 10000,    // £100
};

// Optional add-ons (do NOT change booking time; price only)
const ADDONS = { wax: 1500, polish: 1500 };

/* ---------- Lazy Stripe init (prevents boot crashes) ---------- */
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is missing (set it in Render → Environment).");
  }
  _stripe = new Stripe(key, { apiVersion: "2024-06-20" });
  return _stripe;
}

/* ---------- Helpers ---------- */
function pickOriginFromReqOrEnv(req) {
  const envUrl = (process.env.FRONTEND_PUBLIC_URL || "").trim(); // e.g. https://your-app.vercel.app
  const reqOrigin = (req.headers.origin || "").trim();           // from browser

  const normalize = (u) => {
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) return null;
    return u.replace(/\/+$/, ""); // remove trailing slash(es)
  };

  return normalize(reqOrigin) || normalize(envUrl);
}

/* ======================================================================
   POST /api/pay/create-checkout-session
   Creates a Stripe Checkout Session and returns { ok:true, url: ... }
   ====================================================================== */
export async function createCheckoutSession(req, res) {
  try {
    const { customer, service_key, addons = [], slot, membershipSlots = [] } = req.body || {};

    if (!customer || !service_key) {
      return res.status(400).json({ ok: false, error: "Missing customer or service_key" });
    }

    const origin = pickOriginFromReqOrEnv(req);
    if (!origin) {
      return res.status(500).json({
        ok: false,
        error:
          "Could not determine front-end URL. Set FRONTEND_PUBLIC_URL in Render to your Vercel URL (e.g. https://your-app.vercel.app).",
      });
    }

    const stripe = getStripe();

    // Build line items (base + add-ons)
    const baseAmount = PRICES[service_key];
    if (typeof baseAmount !== "number") {
      return res.status(400).json({ ok: false, error: `Unknown service_key: ${service_key}` });
    }

    const line_items = [
      {
        price_data: {
          currency: CURRENCY,
          product_data: { name: service_key.replace(/_/g, " ") },
          unit_amount: baseAmount,
        },
        quantity: 1,
      },
      ...addons
        .filter((k) => k in ADDONS)
        .map((k) => ({
          price_data: {
            currency: CURRENCY,
            product_data: { name: `Addon: ${k}` },
            unit_amount: ADDONS[k],
          },
          quantity: 1,
        })),
    ];

    // Put everything needed for calendar creation into metadata
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
      success_url: `${origin}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?cancelled=1`,
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[createCheckoutSession] error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Failed to create checkout session" });
  }
}

/* ======================================================================
   POST /api/webhooks/stripe  (mounted with express.raw in server.js)
   Verifies event and creates Google Calendar event(s) on success.
   ====================================================================== */
export async function stripeWebhook(req, res) {
  try {
    const sig = req.headers["stripe-signature"];
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    if (whSecret && req.rawBody) {
      // Verify signature using the RAW body (server.js must pass express.raw)
      event = getStripe().webhooks.constructEvent(req.rawBody, sig, whSecret);
    } else {
      // Dev fallback (no signature verification)
      event = req.body;
      console.warn("[stripeWebhook] WARNING: Missing STRIPE_WEBHOOK_SECRET or rawBody; skipping signature verification.");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const md = session.metadata || {};

      const service_key = md.service_key;
      const addons = JSON.parse(md.addons || "[]");
      const customer = JSON.parse(md.customer || "{}");
      const slot = md.slot ? JSON.parse(md.slot) : null;
      const membershipSlots = md.membershipSlots ? JSON.parse(md.membershipSlots) : [];

      // Create events: memberships may contain 1–2 visits
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
          console.error("[stripeWebhook] Calendar insert failed:", e);
        }
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("[stripeWebhook] error:", err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
}
