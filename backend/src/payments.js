// backend/payments.js
import express from "express";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// simple price table (GBP)
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

// robust origin getter -> absolute https://host
function resolveOrigin(req) {
  const cand =
    req.body?.origin ||
    req.get("origin") ||
    req.get("referer") ||
    process.env.PUBLIC_APP_ORIGIN;

  try {
    const u = new URL(cand);
    // we only want scheme + host, not a path
    return `${u.protocol}//${u.host}`;
  } catch {
    if (process.env.PUBLIC_APP_ORIGIN) return process.env.PUBLIC_APP_ORIGIN;
    return null;
  }
}

export function mountPayments(app) {
  // JSON only for this route (webhook keeps raw in server.js)
  app.post("/api/pay/create-checkout-session", express.json(), async (req, res) => {
    try {
      const origin = resolveOrigin(req);
      if (!origin) {
        return res.status(400).json({ ok: false, error: "No valid URL for return." });
      }

      const {
        customer = {},
        service_key,
        addons = [],
        slot,                   // for 1-off booking
        membershipSlots = [],   // for 2-slot memberships
      } = req.body || {};

      if (!service_key) {
        return res.status(400).json({ ok: false, error: "Missing service_key." });
      }

      const base = SERVICE_PRICES[service_key] ?? 0;
      const addonsTotal = (addons || []).reduce(
        (s, k) => s + (ADDON_PRICES[k] ?? 0),
        0
      );
      const total = base + addonsTotal;
      if (!total || total <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid amount." });
      }

      // Build nice description
      const titleMap = {
        exterior: "Exterior Detail",
        full: "Full Detail",
        standard_membership: "Standard Membership (2 Exterior)",
        premium_membership: "Premium Membership (2 Full)",
      };
      const productName = `GM Auto Detailing – ${titleMap[service_key] || service_key}`;

      // Metadata for your records (visible in Stripe)
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
              unit_amount: Math.round(total * 100), // pence
              product_data: {
                name: productName,
                description: addons.length
                  ? `Add-ons: ${addons.join(", ")}`
                  : undefined,
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
  });
}
