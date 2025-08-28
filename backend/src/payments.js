// backend/src/payments.js
import express from "express";
import Stripe from "stripe";
import { saveBooking } from "./db.js";
import { createCalendarEvent } from "./gcal.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const SERVICE_PRICES = {
  exterior: 40,
  full: 60,
  standard_membership: 70,
  premium_membership: 100,
};
const ADDON_PRICES = { wax: 10, polish: 22.5 };
const DISCOUNT_GBP = Number(process.env.DISCOUNT_GBP || "0");

function resolveOrigin(req) {
  const cand = req.body?.origin || req.get("origin") || req.get("referer") || process.env.PUBLIC_APP_ORIGIN;
  try { const u = new URL(cand); return `${u.protocol}//${u.host}`; }
  catch { return process.env.PUBLIC_APP_ORIGIN || null; }
}

export async function createCheckoutSession(req, res) {
  try {
    const origin = resolveOrigin(req);
    if (!origin) return res.status(400).json({ ok: false, error: "No valid URL for return." });

    const {
      customer = {},
      has_tap = false,
      service_key,
      addons = [],
      slot,
      membershipSlots = [],
    } = req.body || {};

    if (!service_key) return res.status(400).json({ ok: false, error: "Missing service_key." });

    const base = SERVICE_PRICES[service_key] ?? 0;
    const addonsTotal = (addons || []).reduce((s, k) => s + (ADDON_PRICES[k] ?? 0), 0);
    const preDiscount = base + addonsTotal;
    const discount = Math.min(DISCOUNT_GBP, preDiscount);
    const total = preDiscount - discount;
    if (total <= 0) return res.status(400).json({ ok: false, error: "Invalid amount." });

    const titleMap = {
      exterior: "Exterior Detail",
      full: "Full Detail",
      standard_membership: "Standard Membership (2 Exterior)",
      premium_membership: "Premium Membership (2 Full)",
    };
    const productName = `GM Auto Detailing – ${titleMap[service_key] || service_key}`;

    // Put all booking info into metadata so webhook can save + write to Calendar
    const md = {
      service_key,
      addons: (addons || []).join(","),
      customer_name: customer?.name || "",
      customer_email: customer?.email || "",
      customer_phone: customer?.phone || "",
      customer_street: customer?.street || "",
      customer_postcode: customer?.postcode || "",
      has_tap: has_tap ? "yes" : "no",
      discount_gbp: String(discount || 0),
    };

    if (membershipSlots?.length === 2) {
      md.m1_start_iso = membershipSlots[0]?.start_iso || "";
      md.m1_end_iso   = membershipSlots[0]?.end_iso || "";
      md.m2_start_iso = membershipSlots[1]?.start_iso || "";
      md.m2_end_iso   = membershipSlots[1]?.end_iso || "";
    } else if (slot) {
      md.slot_start_iso = slot.start_iso || "";
      md.slot_end_iso   = slot.end_iso || "";
    }

    const descriptionParts = [];
    if (addons.length) descriptionParts.push(`Add-ons: ${addons.join(", ")}`);
    if (discount) descriptionParts.push(`£${discount} intro discount applied`);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      currency: "gbp",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "gbp",
          unit_amount: Math.round(total * 100),
          product_data: {
            name: productName,
            description: descriptionParts.join(" • ") || undefined,
          },
        },
      }],
      success_url: `${origin}?paid=1`,
      cancel_url: `${origin}?canceled=1`,
      customer_email: customer?.email || undefined,
      allow_promotion_codes: true,
      metadata: md,
    });

    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[pay:create-checkout-session] error", err);
    res.status(500).json({ ok: false, error: "Stripe error. " + (err?.message || "") });
  }
}

// RAW body route must be mounted in server.js
export async function stripeWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe:webhook] signature verify failed", err?.message);
    return res.sendStatus(400);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;

      // Pull metadata
      const md = s.metadata || {};
      const customer = {
        name: md.customer_name || "",
        email: md.customer_email || "",
        phone: md.customer_phone || "",
        street: md.customer_street || "",
        postcode: md.customer_postcode || "",
      };
      const baseBooking = {
        stripe_session_id: s.id,
        service_key: md.service_key,
        addons: (md.addons || "").split(",").filter(Boolean),
        customer,
        has_tap: (md.has_tap || "") === "yes",
      };

      // Single or membership (two) bookings
      const items = [];
      if (md.m1_start_iso && md.m2_start_iso) {
        items.push({ ...baseBooking, start_iso: md.m1_start_iso, end_iso: md.m1_end_iso });
        items.push({ ...baseBooking, start_iso: md.m2_start_iso, end_iso: md.m2_end_iso });
      } else if (md.slot_start_iso) {
        items.push({ ...baseBooking, start_iso: md.slot_start_iso, end_iso: md.slot_end_iso });
      }

      for (const b of items) {
        // Save to DB
        try { await saveBooking(b); } catch (e) { console.warn("[db] saveBooking failed", e?.message); }

        // Create Calendar event
        try {
          const svcTitle = {
            exterior: "Exterior Detail",
            full: "Full Detail",
            standard_membership: "Standard Membership – Exterior",
            premium_membership: "Premium Membership – Full",
          }[b.service_key] || b.service_key;

          const desc = [
            `Name: ${b.customer.name}`,
            `Phone: ${b.customer.phone}`,
            `Email: ${b.customer.email}`,
            `Address: ${b.customer.street}, ${b.customer.postcode}`,
            b.addons?.length ? `Add-ons: ${b.addons.join(", ")}` : null,
            `Tap available: ${b.has_tap ? "Yes" : "No"}`,
            `Stripe Session: ${s.id}`,
          ].filter(Boolean).join("\n");

          await createCalendarEvent({
            summary: `GM Auto Detailing – ${svcTitle}`,
            description: desc,
            location: `${b.customer.street}, ${b.customer.postcode}`,
            startISO: b.start_iso,
            endISO: b.end_iso,
          });
        } catch (e) {
          console.warn("[gcal] create event failed", e?.message);
        }
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("[stripe:webhook] handler error", err);
    return res.sendStatus(500);
  }
}

export function mountPayments(app) {
  app.post("/api/pay/create-checkout-session", express.json(), createCheckoutSession);
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);
}
