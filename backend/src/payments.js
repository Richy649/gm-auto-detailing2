// backend/src/payments.js
import express from "express";
import Stripe from "stripe";
import { pool, saveBooking } from "./db.js";
import { createCalendarEvents } from "./gcal.js";

/**
 * One-off payments (Exterior / Full):
 *  - For first-time clients, show 50% off on Stripe Checkout via a coupon (duration=once)
 *    that applies ONLY to the Exterior/Full products. Add-ons are not discounted.
 *  - Fallback: if coupon/price IDs are missing or ineligible, we halve the service price server-side.
 *
 * ENV expected:
 *   STRIPE_SECRET_KEY               = sk_test_... / sk_live_...
 *   STRIPE_WEBHOOK_SECRET           = whsec_...
 *   FRONTEND_PUBLIC_URL             = https://book.gmautodetailing.uk (or equivalent)
 *
 *   ONEOFF_EXTERIOR_PRICE           = price_... (normal price for Exterior one-off)
 *   ONEOFF_FULL_PRICE               = price_... (normal price for Full one-off)
 *
 *   # You may supply EITHER a coupon id OR a promotion code id; the code will detect which is which.
 *   ONEOFF_INTRO_COUPON             = <coupon id or promo code id>
 *     - Coupon id examples:   "7rShjNWE" or "coupon_1QAZ...".
 *     - Promo code id:        "promo_ABC123..."
 *
 *   (Optional) Saved add-on prices:
 *     ADDON_WAX_PRICE               = price_...
 *     ADDON_POLISH_PRICE            = price_...
 */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

/* ------------------------------- ENV HELPERS ------------------------------- */
const ENV = {
  FRONTEND_PUBLIC_URL:
    (process.env.FRONTEND_PUBLIC_URL ||
      process.env.PUBLIC_APP_ORIGIN ||
      process.env.PUBLIC_FRONTEND_ORIGIN ||
      "https://book.gmautodetailing.uk").trim(),

  ONEOFF_EXTERIOR_PRICE: (process.env.ONEOFF_EXTERIOR_PRICE || "").trim(),
  ONEOFF_FULL_PRICE: (process.env.ONEOFF_FULL_PRICE || "").trim(),

  ONEOFF_INTRO_COUPON: (process.env.ONEOFF_INTRO_COUPON || "").trim(), // coupon id OR promo code id

  ADDON_WAX_PRICE: (process.env.ADDON_WAX_PRICE || "").trim(),
  ADDON_POLISH_PRICE: (process.env.ADDON_POLISH_PRICE || "").trim(),
};

function strictFrontendOrigin() {
  try {
    return new URL(ENV.FRONTEND_PUBLIC_URL).origin;
  } catch {
    return "https://book.gmautodetailing.uk";
  }
}
function sanitize(s) {
  return (s ?? "").toString().replace(/[\u0000-\u001F\u007F\uFFFF]/g, "").trim();
}
function normEmail(s) {
  return sanitize(s).toLowerCase();
}
function normStreet(s) {
  return sanitize(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function money(pence) {
  return `£${(Number(pence) / 100).toFixed(0)}`;
}

/* --------------------- FIRST-TIME CHECK (server-side) ---------------------- */
async function isFirstTimeCustomer({ email, phone, street }) {
  const emailNorm = normEmail(email);
  const phoneNorm = sanitize(phone);
  const streetNorm = normStreet(street);

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
  return r.rowCount === 0;
}

/* ---------------------------- PRODUCT CATALOGUE ---------------------------- */
const SERVICE_KEYS = new Set(["exterior", "full"]);
const ADDON_KEYS = new Set(["wax", "polish"]);

/* -------------------------- Persistence + GCal ----------------------------- */
async function persistAndSync(sessionId, payload) {
  const svcNameMap = { exterior: "Exterior Detail", full: "Full Detail" };
  const itemsForCalendar = [];
  for (const sl of (payload.slots || [])) {
    await saveBooking({
      stripe_session_id: sessionId,
      service_key: payload.service_key,
      addons: payload.addons || [],
      start_iso: sl.start_iso,
      end_iso: sl.end_iso,
      customer: payload.customer || {},
      has_tap: !!payload.has_tap,
    });

    const desc = [
      `Name: ${payload.customer?.name || ""}`,
      `Phone: ${payload.customer?.phone || ""}`,
      `Email: ${payload.customer?.email || ""}`,
      `Address: ${payload.customer?.street || ""}, ${payload.customer?.postcode || ""}`,
      `Outhouse tap: ${payload.has_tap ? "Yes" : "No"}`,
      (payload.addons?.length ? `Add-ons: ${payload.addons.join(", ")}` : null),
      `Stripe session: ${sessionId}`,
    ]
      .filter(Boolean)
      .join("\n");

    itemsForCalendar.push({
      start_iso: sl.start_iso,
      end_iso: sl.end_iso,
      summary: `GM Auto Detailing — ${svcNameMap[payload.service_key] || payload.service_key}`,
      description: desc,
      location: `${payload.customer?.street || ""}, ${payload.customer?.postcode || ""}`.trim(),
    });
  }
  await createCalendarEvents(sessionId, itemsForCalendar);
}

/* ----------------------- Coupon / Promo diagnostics ------------------------ */
/**
 * Determine whether ONEOFF_INTRO_COUPON env contains a coupon id or a promotion code id.
 * Returns: { type: "coupon"|"promotion_code"|"unknown", id, coupon?, promotionCode? }
 * Also validates that the coupon is active and logs applies_to metadata.
 */
async function inspectDiscountForOneOff(servicePriceId) {
  const id = ENV.ONEOFF_INTRO_COUPON;
  if (!id) return { type: "unknown", id: "", applies: false, reason: "no_env" };

  // Get the product of the service price to validate applies_to.products
  let servicePrice, serviceProductId;
  try {
    servicePrice = await stripe.prices.retrieve(servicePriceId);
    serviceProductId = servicePrice?.product;
  } catch (e) {
    return { type: "unknown", id, applies: false, reason: `price_lookup_failed: ${e?.message}` };
  }

  // Heuristic: promo codes always start with "promo_"
  const looksLikePromo = id.startsWith("promo_");

  if (looksLikePromo) {
    try {
      const promotionCode = await stripe.promotionCodes.retrieve(id);
      const couponId = promotionCode?.coupon?.id || promotionCode?.coupon || promotionCode?.coupon_id;
      if (!couponId) {
        return { type: "promotion_code", id, applies: false, reason: "promo_has_no_coupon" };
      }
      const coupon = await stripe.coupons.retrieve(couponId);
      const { percent_off, amount_off, currency, valid, duration, applies_to } = coupon || {};
      const appliesAll = !applies_to || !Array.isArray(applies_to?.products) || applies_to.products.length === 0;
      const appliesProduct =
        appliesAll || (Array.isArray(applies_to?.products) && applies_to.products.includes(serviceProductId));

      const amountDesc =
        typeof percent_off === "number"
          ? `${percent_off}%`
          : typeof amount_off === "number"
          ? `${money(amount_off)} ${currency ? currency.toUpperCase() : ""}`
          : "unknown";

      console.log(
        `[oneoff] promo=${id} -> coupon=${coupon.id} valid=${!!valid} duration=${duration} amount=${amountDesc} appliesAll=${appliesAll} appliesProduct=${appliesProduct} product=${serviceProductId}`
      );

      return {
        type: "promotion_code",
        id,
        couponId: coupon.id,
        applies: !!valid && appliesProduct,
        reason: !!valid ? (appliesProduct ? "ok" : "coupon_not_applicable_to_product") : "coupon_invalid",
      };
    } catch (e) {
      return { type: "promotion_code", id, applies: false, reason: `promo_lookup_failed: ${e?.message}` };
    }
  } else {
    // Treat as a coupon id
    try {
      const coupon = await stripe.coupons.retrieve(id);
      const { percent_off, amount_off, currency, valid, duration, applies_to } = coupon || {};
      const appliesAll = !applies_to || !Array.isArray(applies_to?.products) || applies_to.products.length === 0;
      const appliesProduct =
        appliesAll || (Array.isArray(applies_to?.products) && applies_to.products.includes(serviceProductId));

      const amountDesc =
        typeof percent_off === "number"
          ? `${percent_off}%`
          : typeof amount_off === "number"
          ? `${money(amount_off)} ${currency ? currency.toUpperCase() : ""}`
          : "unknown";

      console.log(
        `[oneoff] coupon=${id} valid=${!!valid} duration=${duration} amount=${amountDesc} appliesAll=${appliesAll} appliesProduct=${appliesProduct} product=${serviceProductId}`
      );

      return {
        type: "coupon",
        id,
        applies: !!valid && appliesProduct,
        reason: !!valid ? (appliesProduct ? "ok" : "coupon_not_applicable_to_product") : "coupon_invalid",
      };
    } catch (e) {
      return { type: "coupon", id, applies: false, reason: `coupon_lookup_failed: ${e?.message}` };
    }
  }
}

/* --------------------------------- Mount ---------------------------------- */
export function mountPayments(app) {
  /**
   * Create Checkout Session (one-off)
   * Body: { customer, has_tap, service_key: "exterior"|"full", addons:[], slot, origin? }
   */
  app.post("/api/pay/create-checkout-session", express.json(), async (req, res) => {
    try {
      const { customer, has_tap, service_key, addons = [], slot, origin } = req.body || {};
      if (!customer || !service_key || !slot?.start_iso || !slot?.end_iso) {
        return res.status(400).json({ ok: false, error: "Please select a time and complete your details." });
      }
      if (!SERVICE_KEYS.has(service_key)) {
        return res.status(400).json({ ok: false, error: "Invalid service." });
      }

      const successBase = (() => {
        try {
          return new URL(origin).origin;
        } catch {
          return strictFrontendOrigin();
        }
      })();

      const firstTime = await isFirstTimeCustomer({
        email: customer?.email,
        phone: customer?.phone,
        street: customer?.street,
      });

      // Determine saved price for the service
      const servicePriceId =
        service_key === "exterior" ? ENV.ONEOFF_EXTERIOR_PRICE
        : service_key === "full"   ? ENV.ONEOFF_FULL_PRICE
        : "";

      // Decide discount path (coupon/promo vs fallback)
      let discountStrategy = { useStripeDiscount: false, field: null, value: null, debug: "" };

      if (firstTime && servicePriceId && ENV.ONEOFF_INTRO_COUPON) {
        // Inspect the env id to decide coupon vs promotion_code
        const isPromo = ENV.ONEOFF_INTRO_COUPON.startsWith("promo_");
        discountStrategy = {
          useStripeDiscount: true,
          field: isPromo ? "promotion_code" : "coupon",
          value: ENV.ONEOFF_INTRO_COUPON,
          debug: isPromo ? "promotion_code" : "coupon",
        };

        // Deep check and log applicability; if it won’t apply, we’ll fall back
        const probe = await inspectDiscountForOneOff(servicePriceId);
        if (!probe.applies) {
          console.warn(`[oneoff] discount '${ENV.ONEOFF_INTRO_COUPON}' will not apply: ${probe.reason}. Falling back to server-side half price.`);
          discountStrategy = { useStripeDiscount: false, field: null, value: null, debug: `ineligible (${probe.reason})` };
        }
      }

      // Build line items
      const line_items = [];

      if (servicePriceId && !discountStrategy.useStripeDiscount) {
        // We have a saved price but the coupon is unavailable/ineligible; halve via dynamic price
        // Retrieve to read normal amount for messaging
        let normalAmount = 0;
        try {
          const p = await stripe.prices.retrieve(servicePriceId);
          normalAmount = p?.unit_amount ?? 0;
        } catch {}
        const amount = firstTime ? Math.floor(normalAmount / 2) : normalAmount;
        line_items.push({
          price_data: {
            currency: "gbp",
            product_data: { name: service_key === "exterior" ? "Exterior Detail" : "Full Detail" },
            unit_amount: amount,
          },
          quantity: 1,
        });
      } else if (servicePriceId) {
        // Normal path: saved price so Stripe discount applies
        line_items.push({ price: servicePriceId, quantity: 1 });
      } else {
        // No saved price provided at all — pure fallback
        const fallbackNormal = service_key === "exterior" ? 4000 : 6000; // adjust if desired
        const amount = firstTime ? Math.floor(fallbackNormal / 2) : fallbackNormal;
        line_items.push({
          price_data: {
            currency: "gbp",
            product_data: { name: service_key === "exterior" ? "Exterior Detail" : "Full Detail" },
            unit_amount: amount,
          },
          quantity: 1,
        });
      }

      // Add-ons
      for (const k of addons) {
        if (!ADDON_KEYS.has(k)) continue;
        if (k === "wax" && ENV.ADDON_WAX_PRICE) {
          line_items.push({ price: ENV.ADDON_WAX_PRICE, quantity: 1 });
        } else if (k === "polish" && ENV.ADDON_POLISH_PRICE) {
          line_items.push({ price: ENV.ADDON_POLISH_PRICE, quantity: 1 });
        } else {
          const unit = k === "wax" ? 1000 : 2250; // £10 / £22.50
          line_items.push({
            price_data: { currency: "gbp", product_data: { name: k === "wax" ? "Full Body Wax" : "Hand Polish" }, unit_amount: unit },
            quantity: 1,
          });
        }
      }

      // Payload for persistence
      const payload = {
        service_key,
        addons,
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

      // Submit message
      let submitMessage = "";
      if (firstTime) {
        submitMessage = discountStrategy.useStripeDiscount
          ? "Intro 50% off this booking, then standard pricing next time."
          : "Intro 50% off this booking applied.";
      }

      // Build session
      const sessionParams = {
        mode: "payment",
        line_items,
        success_url: `${successBase}/?paid=1&flow=oneoff&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: successBase,
        metadata: { payload: JSON.stringify(payload) },
        custom_text: submitMessage ? { submit: { message: submitMessage } } : undefined,
      };

      if (firstTime && discountStrategy.useStripeDiscount) {
        sessionParams.discounts = [{ [discountStrategy.field]: discountStrategy.value }];
        console.log(`[oneoff] applying Stripe ${discountStrategy.debug}: ${discountStrategy.value}`);
      } else if (firstTime) {
        console.log("[oneoff] applying server-side half-price fallback (no eligible Stripe discount).");
      }

      const session = await stripe.checkout.sessions.create(sessionParams);
      if (!session?.url) return res.status(500).json({ ok: false, error: "Unable to start checkout." });

      return res.json({ ok: true, url: session.url });
    } catch (e) {
      console.error("[pay/create-checkout-session] error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Payment failed to initialise" });
    }
  });

  // Webhook + confirm (unchanged)
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
