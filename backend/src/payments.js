// backend/src/payments.js
import express from "express";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// GBP price table
const SERVICE_PRICES = {
  exterior: 40,
  full: 60,
  standard_membership: 70,
  premium_membership: 100,
};
const ADDON_PRICES = {
  wax: 10,
  polish: 22.5,
};

// Build a safe absolute origin (https://host)
function resolveOrigin(req) {
  const cand =
    req.body?.origin ||
    req.get("origin") ||
    req.get("referer") ||
    process.env.PUBLIC_APP_ORIGIN;

  try {
    const u = new URL(cand);
    return `${u.protocol}//${u.host}`;
  } catch {
    return process.env.PUBLIC_APP_ORIGIN || null;
  }
}

/** POST /api/pay/create-checkout-session (express.json()) */
export async function createCheckoutSession(req, res) {
  try {
    const origin = resolveOrigin(req);
    if (!origin) {
      return res.status(400).json({ ok: false, error: "No valid URL for return." });
    }

    const {
      customer = {},
      service_key,
      addons = [],
      slot,                 // 1-off booking
      membershipSlots = [], // for memberships (2 slots)
    } = req.body || {};

    if (!service_key) {
      return res.status(400).json({ ok: false, error: "Missing service_key." });
    }

    const base = SERVICE_PRICES[service_key] ?? 0;
    const addonsTotal = (addons || []).reduce((s, k) => s + (ADDON_PRICES[k] ?? 0), 0);
    const total = base + addonsTotal;
    if (!total || total <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid amount." });
    }

    const titleMap = {
      exterior: "Exterior Detail",
      full: "Full Detail",
      standard_membership: "Standard Membership (2 Exterior)",
      premium_membership: "Premium Membership (2 Full)",
    };
    const productName = `GM Auto Detailing – ${titleMap[service_key] || service_key}`;

    const md = {
      service_key,
      addons: (addons || []).join(","),
      slot_start: slot?.start_iso || "",
      slot_end: slot?.end_iso || "",
      membership_slots: membershipSlots.length ? "2" : "0",
      customer_name: customer?.name || "",
      customer_email: customer?.email || "",
      customer_phone: customer?.phone || "",
      customer_street: customer?.street || "",
      customer_postcode: customer?.postcode || "",
    };

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      currency: "gbp",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "gbp",
            unit_amount: Math.round(total * 100),
            product_data: {
              name: productName,
              description: addons.length ? `Add-ons: ${addons.join(", ")}` : undefined,
            },
          },
        },
      ],
      success_url: `${origin}?paid=1`,
      cancel_url: `${origin}?canceled=1`,
      customer_email: customer?.email || undefined,
      allow_promotion_codes: true,
      metadata: md,
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[pay:create-checkout-session] error", err);
    return res.status(500).json({ ok: false, error: "Stripe error. " + (err?.message || "") });
  }
}

/** POST /api/webhooks/stripe (express.raw({ type: "application/json" })) */
export async function stripeWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    // If not configured, just 200 OK to avoid retries (adjust if you prefer)
    console.warn("[stripe:webhook] missing signature or secret");
    return res.sendStatus(200);
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe:webhook] signature verify failed", err?.message);
    return res.sendStatus(400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        // TODO: mark booking as confirmed in DB using session.metadata
        console.log("[stripe] checkout.session.completed", {
          id: session.id,
          email: session.customer_details?.email,
          meta: session.metadata,
        });
        break;
      }
      default:
        // handle other events if you add them
        break;
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error("[stripe:webhook] handler error", err);
    return res.sendStatus(500);
  }
}

/** Optional helper if you want to mount in one call */
export function mountPayments(app) {
  app.post("/api/pay/create-checkout-session", express.json(), createCheckoutSession);
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);
}
