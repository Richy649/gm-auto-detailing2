import express from "express";
import Stripe from "stripe";
import { saveBooking, hasExistingCustomer } from "./db.js";
import { createCalendarEvent } from "./gcal.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const SERVICE_PRICES = { exterior:40, full:60, standard_membership:70, premium_membership:100 };
const ADDON_PRICES = { wax:10, polish:22.5 };

function resolveOrigin(req){
  const cand = req.body?.origin || req.get("origin") || req.get("referer") || process.env.PUBLIC_APP_ORIGIN;
  try{ const u=new URL(cand); return `${u.protocol}//${u.host}`; }catch{ return process.env.PUBLIC_APP_ORIGIN || null; }
}

export async function createCheckoutSession(req, res) {
  try {
    const origin = resolveOrigin(req);
    if (!origin) return res.status(400).json({ ok:false, error:"No valid URL for return." });

    const {
      customer = {},
      has_tap = false,
      service_key,
      addons = [],
      slot,
      membershipSlots = [],
    } = req.body || {};

    if (!service_key) return res.status(400).json({ ok:false, error:"Missing service_key." });

    const base = SERVICE_PRICES[service_key] ?? 0;
    const addonsTotal = (addons || []).reduce((s,k)=> s + (ADDON_PRICES[k] ?? 0), 0);

    // Identity-based first-time check
    const identity = {
      email: (customer?.email || "").toLowerCase(),
      phone: customer?.phone || "",
      street: customer?.street || ""
    };
    const seen = await hasExistingCustomer(identity);
    const discount = seen ? 0 : base * 0.5; // 50% off service price only
    const total = Math.max(0, (base - discount) + addonsTotal);
    if (total <= 0) return res.status(400).json({ ok:false, error:"Invalid amount." });

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
      customer_name: customer?.name || "",
      customer_email: identity.email || "",
      customer_phone: identity.phone || "",
      customer_street: identity.street || "",
      customer_postcode: customer?.postcode || "",
      has_tap: has_tap ? "yes" : "no",
      first_time_discount: seen ? "no" : "yes",
      service_base_gbp: String(base),
      service_discount_gbp: String(Math.round(discount * 100) / 100),
      addons_total_gbp: String(addonsTotal),
      final_total_gbp: String(Math.round(total * 100) / 100),
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

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      currency: "gbp",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "gbp",
          unit_amount: Math.round(total * 100),
          product_data: { name: productName }
        },
      }],
      success_url: `${origin}?paid=1`,
      cancel_url: `${origin}?canceled=1`,
      customer_email: identity.email || undefined,
      allow_promotion_codes: true,
      metadata: md,
    });

    res.json({ ok:true, url: session.url });
  } catch (err) {
    console.error("[pay:create-checkout-session] error", err);
    res.status(500).json({ ok:false, error:"Stripe error. " + (err?.message || "") });
  }
}

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
      const md = s.metadata || {};
      const customer = {
        name: md.customer_name || "",
        email: (md.customer_email || ""),
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

      const items = [];
      if (md.m1_start_iso && md.m2_start_iso) {
        items.push({ ...baseBooking, start_iso: md.m1_start_iso, end_iso: md.m1_end_iso });
        items.push({ ...baseBooking, start_iso: md.m2_start_iso, end_iso: md.m2_end_iso });
      } else if (md.slot_start_iso) {
        items.push({ ...baseBooking, start_iso: md.slot_start_iso, end_iso: md.slot_end_iso });
      }

      for (const b of items) {
        try { await saveBooking(b); } catch (e) { console.warn("[db] saveBooking failed", e?.message); }
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
            `Outhouse tap: ${b.has_tap ? "Yes" : "No"}`,
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
