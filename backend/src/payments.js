// backend/src/payments.js
import express from "express";
import Stripe from "stripe";
import { pool, hasExistingCustomer } from "./db.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const APP_ORIGIN =
  (process.env.PUBLIC_APP_ORIGIN ||
    process.env.FRONTEND_PUBLIC_URL ||
    "https://book.gmautodetailing.uk").replace(/\/+$/, "");

const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

const PRICE_EXT   = (process.env.ONEOFF_EXTERIOR_PRICE || "").trim();
const PRICE_FULL  = (process.env.ONEOFF_FULL_PRICE    || "").trim();
const INTRO_COUPON = (process.env.ONEOFF_INTRO_COUPON || "").trim();

const STANDARD_PRICE = (process.env.STANDARD_PRICE || "").trim();
const PREMIUM_PRICE  = (process.env.PREMIUM_PRICE  || "").trim();

/* ==================== utilities ==================== */
const safe = (s) => (s ?? "").toString().trim();
const normEmail = (s) => safe(s).toLowerCase();

function priceForService(service_key) {
  if (service_key === "exterior") return PRICE_EXT;
  if (service_key === "full")     return PRICE_FULL;
  return null;
}

function tierFromPriceId(priceId) {
  if (!priceId) return null;
  if (priceId === STANDARD_PRICE) return "standard";
  if (priceId === PREMIUM_PRICE)  return "premium";
  return null;
}

async function isFirstTimeCustomer(customer) {
  try {
    return !(await hasExistingCustomer({
      email: normEmail(customer?.email || ""),
      phone: safe(customer?.phone),
      street: safe(customer?.street),
    }));
  } catch {
    return false;
  }
}

/* ==================== membership credit helpers (safety-net) ==================== */

async function ensureProcessedEvent(eventId) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.processed_events (
      id text PRIMARY KEY,
      created_at timestamptz DEFAULT now()
    )
  `);
  try {
    await pool.query(`INSERT INTO public.processed_events (id) VALUES ($1)`, [eventId]);
    return true;
  } catch {
    return false;
  }
}

async function upsertSubscription({ user_id, tier, stripe_sub_id, status, current_period_start, current_period_end }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.subscriptions(
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      tier text NOT NULL,
      status text NOT NULL,
      stripe_subscription_id text UNIQUE,
      current_period_start timestamptz,
      current_period_end   timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )
  `);

  await pool.query(`
    INSERT INTO public.subscriptions (user_id, tier, status, stripe_subscription_id, current_period_start, current_period_end, updated_at)
    VALUES ($1,$2,$3,$4,to_timestamp($5),to_timestamp($6),now())
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      tier = EXCLUDED.tier,
      status = EXCLUDED.status,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end   = EXCLUDED.current_period_end,
      updated_at = now()
  `, [
    user_id, tier, status, stripe_sub_id,
    current_period_start ? Number(current_period_start) : null,
    current_period_end   ? Number(current_period_end)   : null
  ]);
}

async function awardMembershipCreditsOnce({ event_id, user_id, tier }) {
  const first = await ensureProcessedEvent(event_id);
  if (!first) {
    console.log(`[oneoff webhook][safety-net] skip awarding (already processed) event=${event_id}`);
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.credit_ledger(
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      service_type text NOT NULL,  -- 'exterior' | 'full'
      qty integer NOT NULL,
      valid_until timestamptz NULL,
      created_at timestamptz DEFAULT now()
    )
  `);

  let service_type = null;
  if (tier === "standard") service_type = "exterior";
  if (tier === "premium")  service_type = "full";
  if (!service_type) {
    console.warn(`[oneoff webhook][safety-net] unknown tier for awarding credits: ${tier}`);
    return;
  }

  await pool.query(
    `INSERT INTO public.credit_ledger (user_id, service_type, qty, valid_until) VALUES ($1,$2,$3,NULL)`,
    [user_id, service_type, 2]
  );

  console.log(`[oneoff webhook][safety-net] credits awarded: user=${user_id} tier=${tier} -> +2 ${service_type}`);
}

async function resolveUserIdByMetaOrEmail({ metaUserId, email }) {
  if (metaUserId) {
    const r = await pool.query(`SELECT id FROM public.users WHERE id=$1`, [metaUserId]);
    if (r.rowCount) return metaUserId;
  }
  if (email) {
    const r = await pool.query(`SELECT id FROM public.users WHERE lower(email)=lower($1)`, [email]);
    if (r.rowCount) return r.rows[0].id;
  }
  return null;
}

/* ==================== one-off checkout ==================== */

export async function createCheckoutSession(req, res) {
  try {
    const { customer, service_key, addons = [], origin, slot, first_time } = req.body || {};
    if (!customer?.email || !service_key) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const priceId = priceForService(service_key);
    if (!priceId) return res.status(400).json({ ok: false, error: "invalid_service" });

    let base;
    try { base = new URL(origin || APP_ORIGIN).origin; }
    catch { base = APP_ORIGIN; }

    let applyCoupon = false;
    if (INTRO_COUPON) {
      if (typeof first_time === "boolean") applyCoupon = first_time;
      else applyCoupon = await isFirstTimeCustomer(customer);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: customer.email,
      line_items: [{ price: priceId, quantity: 1 }],
      discounts: applyCoupon && INTRO_COUPON ? [{ coupon: INTRO_COUPON }] : undefined,
      success_url: `${base}/?thankyou=1&flow=oneoff&paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?cancel=1`,
      metadata: {
        app: "gm",
        kind: "oneoff",
        service_key,
        email: normEmail(customer.email),
        slot_start: slot?.start_iso || "",
        addons: (Array.isArray(addons) ? addons.join(",") : ""),
      },
    });

    console.log(`[oneoff] create session for ${service_key} coupon=${applyCoupon ? INTRO_COUPON : "(none)"}`);
    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[oneoff] create-checkout-session failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "session_failed" });
  }
}

/* ==================== webhook (one-off + safety-net for memberships) ==================== */

export async function stripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (err) {
    console.error("[oneoff webhook] bad signature:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const type = event.type;

  try {
    if (type === "checkout.session.completed") {
      const s = event.data.object; // CheckoutSession
      console.log("[oneoff webhook] checkout.session.completed", s.id);

      // SAFETY-NET: if this Checkout Session is actually a membership (mode=subscription),
      // resolve user/tier and award credits here as well.
      if (s.mode === "subscription") {
        const subId = safe(s.subscription);
        const md = s.metadata || {};
        const email = normEmail(md.email || s.customer_details?.email || s.customer_email || "");

        let sub = null;
        if (subId) {
          sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price.product"] });
        }

        const tier =
          safe(md.tier) ||
          tierFromPriceId(sub?.items?.data?.[0]?.price?.id) ||
          null;

        const user_id = await resolveUserIdByMetaOrEmail({
          metaUserId: safe(md.user_id || sub?.metadata?.user_id),
          email
        });

        if (user_id && tier) {
          await upsertSubscription({
            user_id,
            tier,
            stripe_sub_id: sub?.id || subId || "",
            status: sub?.status || "active",
            current_period_start: sub?.current_period_start || null,
            current_period_end:   sub?.current_period_end   || null,
          });
          await awardMembershipCreditsOnce({ event_id: event.id, user_id, tier });
        } else {
          console.warn("[oneoff webhook][safety-net] unable to resolve user/tier on checkout.session.completed");
        }
      }
    }

    if (type === "invoice.payment_succeeded") {
      // SAFETY-NET: renewals or first invoice for a membership shot into the one-off endpoint
      const inv = event.data.object;
      const subId = safe(inv.subscription);
      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
        const tier =
          safe(sub?.metadata?.tier) ||
          tierFromPriceId(sub?.items?.data?.[0]?.price?.id) ||
          null;

        const email = normEmail(inv.customer_email || "");
        const user_id = await resolveUserIdByMetaOrEmail({
          metaUserId: safe(sub?.metadata?.user_id),
          email
        });

        if (user_id && tier) {
          await upsertSubscription({
            user_id,
            tier,
            stripe_sub_id: sub.id,
            status: sub.status || "active",
            current_period_start: sub.current_period_start || null,
            current_period_end:   sub.current_period_end   || null,
          });
          await awardMembershipCreditsOnce({ event_id: event.id, user_id, tier });
        } else {
          console.warn("[oneoff webhook][safety-net] unable to resolve user/tier on invoice.payment_succeeded");
        }
      }
    }
  } catch (err) {
    console.error("[oneoff webhook] handler error:", err?.message || err);
    // do not 4xx here; Stripe will retry and could double-award without idempotency
  }

  res.json({ received: true });
}

/* ==================== mounting helpers ==================== */

export function mountPaymentsWebhook(app) {
  // Mount webhook with RAW body BEFORE express.json()
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);
}

export function mountPaymentsRoutes(app) {
  // Normal JSON routes AFTER express.json()
  app.post("/api/pay/create-checkout-session", express.json(), createCheckoutSession);
  app.post("/api/pay/confirm", express.json(), async (req, res) => {
    try {
      const { session_id } = req.body || {};
      if (!session_id) return res.status(400).json({ ok: false, error: "missing_session" });
      return res.json({ ok: true });
    } catch (err) {
      console.error("[oneoff] confirm failed:", err?.message || err);
      return res.status(500).json({ ok: false, error: "confirm_failed" });
    }
  });
}

// Backwards compatibility if anything still calls mountPayments(app)
export function mountPayments(app) {
  mountPaymentsWebhook(app);
  mountPaymentsRoutes(app);
}
