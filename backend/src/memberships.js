// backend/src/memberships.js
import express from "express";
import Stripe from "stripe";
import { pool, hasExistingCustomer } from "./db.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET_MEMBERSHIPS || "").trim();

const STANDARD_PRICE = (process.env.STANDARD_PRICE || "").trim();
const PREMIUM_PRICE  = (process.env.PREMIUM_PRICE  || "").trim();
const INTRO_COUPON   = (process.env.MEMBERSHIP_INTRO_COUPON || "").trim();

const APP_ORIGIN =
  (process.env.PUBLIC_APP_ORIGIN ||
    process.env.FRONTEND_PUBLIC_URL ||
    "https://book.gmautodetailing.uk").replace(/\/+$/, "");

/* --------------------------- helpers --------------------------- */
const safe = (s) => (s ?? "").toString().trim();
const normEmail = (s) => safe(s).toLowerCase();

function priceForTier(tier) {
  if (tier === "standard") return STANDARD_PRICE;
  if (tier === "premium")  return PREMIUM_PRICE;
  return null;
}

function tierFromPriceId(priceId) {
  if (!priceId) return null;
  if (priceId === STANDARD_PRICE) return "standard";
  if (priceId === PREMIUM_PRICE)  return "premium";
  return null;
}

async function ensureProcessedEvent(eventId) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.processed_events (
      id text PRIMARY KEY,
      created_at timestamptz DEFAULT now()
    )
  `);
  try {
    await pool.query(`INSERT INTO public.processed_events (id) VALUES ($1)`, [eventId]);
    return true; // first time processed
  } catch {
    return false; // already processed
  }
}

async function resolveUserId({ userId, email }) {
  if (userId) {
    const r = await pool.query(`SELECT id FROM public.users WHERE id=$1`, [userId]);
    if (r.rowCount) return userId;
  }
  if (email) {
    const r = await pool.query(`SELECT id FROM public.users WHERE lower(email)=lower($1)`, [email]);
    if (r.rowCount) return r.rows[0].id;
  }
  return null;
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
    VALUES ($1,$2,$3,$4, to_timestamp($5), to_timestamp($6), now())
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
    console.log(`[memberships] skip awarding (already processed) event=${event_id}`);
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
  let qty = 2;
  if (tier === "standard") service_type = "exterior";
  if (tier === "premium")  service_type = "full";
  if (!service_type) {
    console.warn(`[memberships] unknown tier when awarding credits: ${tier}`);
    return;
  }

  await pool.query(
    `INSERT INTO public.credit_ledger (user_id, service_type, qty, valid_until) VALUES ($1,$2,$3,NULL)`,
    [user_id, service_type, qty]
  );

  console.log(`[memberships] credits awarded: user=${user_id} tier=${tier} -> +${qty} ${service_type}`);
}

/* --------------------- public: subscribe & portal --------------------- */

/**
 * POST /api/memberships/subscribe
 * Body: { tier: 'standard'|'premium', customer:{email,name,phone,street,postcode}, origin?, first_time? }
 *
 * - Applies INTRO_COUPON to the Checkout Session **only if** the customer is first-time.
 * - Adds metadata (user_id, tier, email) to session & subscription so webhooks can award credits.
 */
router.post("/subscribe", express.json(), async (req, res) => {
  try {
    const { tier, customer, origin, first_time } = req.body || {};
    const email = normEmail(customer?.email || "");
    if (!tier || !email) return res.status(400).json({ ok:false, error: "missing_fields" });

    const price = priceForTier(tier);
    if (!price) return res.status(500).json({ ok:false, error:"price_not_configured" });

    let base;
    try { base = new URL(origin || APP_ORIGIN).origin; }
    catch { base = APP_ORIGIN; }

    // Resolve user_id (if already registered)
    let userId = null;
    try {
      const r = await pool.query(`SELECT id FROM public.users WHERE lower(email)=lower($1)`, [email]);
      if (r.rowCount) userId = r.rows[0].id;
    } catch {}

    // Determine if coupon applies
    let applyCoupon = false;
    if (INTRO_COUPON) {
      if (typeof first_time === "boolean") {
        applyCoupon = first_time;
      } else {
        // Server-side check using your customer record
        applyCoupon = !(await hasExistingCustomer({
          email,
          phone: safe(customer?.phone),
          street: safe(customer?.street),
        }));
      }
    }

    const sessionParams = {
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      success_url: `${base}/?thankyou=1&flow=sub&sub=1`,
      cancel_url: `${base}/?sub=cancel`,
      customer_email: email || undefined,
      metadata: {
        app: "gm",
        tier,
        user_id: userId ? String(userId) : "",
        email
      },
      subscription_data: {
        metadata: {
          app: "gm",
          tier,
          user_id: userId ? String(userId) : "",
          email
        }
      }
    };

    // ✅ Correct way to apply a coupon to a Checkout Session (mode=subscription)
    if (applyCoupon && INTRO_COUPON) {
      sessionParams.discounts = [{ coupon: INTRO_COUPON }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`[memberships] origin=${base} success_url=${base}/?thankyou=1&flow=sub&sub=1 cancel_url=${base}/?sub=cancel`);
    if (applyCoupon && INTRO_COUPON) {
      console.log(`[memberships] applying intro coupon ${INTRO_COUPON} for ${email}`);
    }
    return res.json({ ok:true, url: session.url });
  } catch (e) {
    console.error("[memberships/subscribe] failed:", e);
    return res.status(500).json({ ok:false, error:"init_failed" });
  }
});

/**
 * POST /api/memberships/portal
 * Body: none (user derived from token by your /auth/me usage in FE)
 * Return: { url }
 */
router.post("/portal", express.json(), async (req, res) => {
  try {
    const email = normEmail(req.headers["x-user-email"] || req.body?.email || "");
    if (!email) return res.status(400).json({ ok:false, error:"email_required" });

    // Find customer by email
    const customers = await stripe.customers.list({ email, limit: 1 });
    const cust = customers.data[0];
    if (!cust) return res.status(404).json({ ok:false, error:"no_customer" });

    const portal = await stripe.billingPortal.sessions.create({
      customer: cust.id,
      return_url: `${APP_ORIGIN}/account.html`
    });
    return res.json({ ok:true, url: portal.url });
  } catch (e) {
    console.error("[memberships/portal] failed:", e?.message || e);
    return res.status(500).json({ ok:false, error:"portal_failed" });
  }
});

/* ------------------------- webhook: memberships ------------------------ */

export async function handleMembershipWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (err) {
    console.error("[webhooks/memberships] signature verification failed:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const type = event.type;
  console.log("[webhooks/memberships] received:", type);

  try {
    if (type === "checkout.session.completed") {
      const sess = event.data.object;
      if (sess?.mode === "subscription") {
        const md = sess.metadata || {};
        const subId = safe(sess.subscription);
        const email = normEmail(md.email || sess.customer_details?.email || sess.customer_email || "");

        let sub = null;
        if (subId) {
          sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price.product"] });
        }

        const subMd = sub?.metadata || {};
        const metaTier = safe(md.tier || subMd.tier);
        const tier = metaTier || tierFromPriceId(sub?.items?.data?.[0]?.price?.id) || null;

        const user_id = await resolveUserId({ userId: safe(md.user_id || subMd.user_id), email });

        if (user_id && tier) {
          await upsertSubscription({
            user_id,
            tier,
            stripe_sub_id: sub?.id || subId || "",
            status: sub?.status || "active",
            current_period_start: sub?.current_period_start || null,
            current_period_end:   sub?.current_period_end   || null,
          });

          // Award initial credits; independent of coupon/discounts
          await awardMembershipCreditsOnce({ event_id: event.id, user_id, tier });
        } else {
          console.warn("[webhooks/memberships] unable to resolve user/tier on checkout.session.completed");
        }
      }
    }

    if (type === "invoice.payment_succeeded") {
      const inv = event.data.object;
      if (inv?.billing_reason === "subscription_cycle" || inv?.billing_reason === "subscription_create") {
        const subId = safe(inv.subscription);
        let sub = null;
        if (subId) sub = await stripe.subscriptions.retrieve(subId);

        const email = normEmail(inv.customer_email || "");
        const tier = safe(sub?.metadata?.tier) || tierFromPriceId(sub?.items?.data?.[0]?.price?.id) || null;

        const user_id = await resolveUserId({ userId: safe(sub?.metadata?.user_id), email });

        if (user_id && tier) {
          await upsertSubscription({
            user_id,
            tier,
            stripe_sub_id: sub?.id || subId,
            status: sub?.status || "active",
            current_period_start: sub?.current_period_start || null,
            current_period_end:   sub?.current_period_end   || null,
          });

          // Award cycle credits; independent of coupon/discounts
          await awardMembershipCreditsOnce({ event_id: event.id, user_id, tier });
        } else {
          console.warn("[webhooks/memberships] unable to resolve user/tier on invoice.payment_succeeded");
        }
      }
    }
  } catch (err) {
    console.error("[webhooks/memberships] handler error:", err?.message || err);
    // Return 200 so Stripe doesn't retry endlessly on our logging errors
  }

  res.json({ received: true });
}

/* default export: router */
export default router;
