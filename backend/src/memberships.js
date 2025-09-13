// backend/src/memberships.js
import express from "express";
import Stripe from "stripe";
import { pool } from "./db.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET_MEMBERSHIPS;

// Prices you already have in env
const STANDARD_PRICE = (process.env.STANDARD_PRICE || "").trim();
const PREMIUM_PRICE  = (process.env.PREMIUM_PRICE  || "").trim();

// If you also use intro prices or coupons for memberships, DO NOT change your logic;
// we’re only adding metadata and improving webhook awarding. Your existing code path stays.

// --------- helpers ----------
const safe = (s) => (s ?? "").toString().trim();
const normEmail = (s) => safe(s).toLowerCase();

// map a price id -> tier
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
    return true; // first time
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
  // Basic subscriptions table upsert (adjust names if your columns differ)
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
  // Idempotency via processed_events table
  const ok = await ensureProcessedEvent(event_id);
  if (!ok) {
    console.log(`[memberships] skip awarding (already processed) event=${event_id}`);
    return;
  }

  // credit_ledger table assumed from your app; columns used before: user_id, service_type, qty, valid_until?
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

  await pool.query(`
    INSERT INTO public.credit_ledger (user_id, service_type, qty, valid_until)
    VALUES ($1, $2, $3, NULL)
  `, [user_id, service_type, qty]);

  console.log(`[memberships] credits awarded: user=${user_id} tier=${tier} -> +${qty} ${service_type}`);
}

// --------- subscribe route ----------
router.post("/subscribe", express.json(), async (req, res) => {
  try {
    const { tier, customer, origin } = req.body || {};
    if (!tier || !customer?.email) return res.status(400).json({ ok:false, error: "missing_fields" });

    const successBase = (() => { try { return new URL(origin).origin; } catch { return safe(process.env.FRONTEND_PUBLIC_URL) || "https://book.gmautodetailing.uk"; } })();

    // Resolve user_id now (helpful metadata for webhook)
    let userId = null;
    try {
      const r = await pool.query(`SELECT id FROM public.users WHERE lower(email)=lower($1)`, [customer.email]);
      if (r.rowCount) userId = r.rows[0].id;
    } catch {}

    // Pick price by tier (you already validated this previously)
    const price = tier === "premium" ? PREMIUM_PRICE : STANDARD_PRICE;
    if (!price) return res.status(500).json({ ok:false, error:"price_not_configured" });

    // Build subscription session; just add METADATA (key fix)
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      success_url: `${successBase}/?thankyou=1&flow=sub&sub=1`,
      cancel_url: `${successBase}/?sub=cancel`,
      // Helpful: set both session-level and subscription-level metadata
      metadata: {
        app: "gm",
        tier,
        user_id: userId ? String(userId) : "",
        email: safe(customer.email)
      },
      subscription_data: {
        metadata: {
          app: "gm",
          tier,
          user_id: userId ? String(userId) : "",
          email: safe(customer.email)
        }
      },
      customer_email: safe(customer.email) || undefined
    });

    console.log(`[memberships] origin=${successBase} success_url=${successBase}/?thankyou=1&flow=sub&sub=1 cancel_url=${successBase}/?sub=cancel`);
    return res.json({ ok:true, url: session.url });
  } catch (e) {
    console.error("[memberships/subscribe] failed:", e);
    return res.status(500).json({ ok:false, error:"init_failed" });
  }
});

// --------- webhook handler (exported) ----------
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
        // Resolve user and tier
        const md = sess.metadata || {};
        const subId = safe(sess.subscription);
        const email = normEmail(md.email || sess.customer_details?.email || sess.customer_email || "");

        // Fetch subscription to read metadata/items
        let sub = null;
        if (subId) {
          sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price.product"] });
        }

        const subMd = sub?.metadata || {};
        const metaTier = safe(md.tier || subMd.tier);
        const tier =
          metaTier ||
          tierFromPriceId(sub?.items?.data?.[0]?.price?.id) ||
          null;

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

          // Award initial credits on successful checkout for the new sub
          await awardMembershipCreditsOnce({ event_id: event.id, user_id, tier });
        } else {
          console.warn("[webhooks/memberships] unable to resolve user/tier on checkout.session.completed");
        }
      }
    }

    if (type === "invoice.payment_succeeded") {
      // Renewing invoice (or first invoice). Award credits for each successful period too.
      const inv = event.data.object;
      if (inv?.billing_reason === "subscription_cycle" || inv?.billing_reason === "subscription_create") {
        const subId = safe(inv.subscription);
        let sub = null;
        if (subId) sub = await stripe.subscriptions.retrieve(subId);

        const email = normEmail(inv.customer_email || "");
        const tier =
          safe(sub?.metadata?.tier) ||
          tierFromPriceId(sub?.items?.data?.[0]?.price?.id) ||
          null;

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

          await awardMembershipCreditsOnce({ event_id: event.id, user_id, tier });
        } else {
          console.warn("[webhooks/memberships] unable to resolve user/tier on invoice.payment_succeeded");
        }
      }
    }
  } catch (err) {
    console.error("[webhooks/memberships] handler error:", err?.message || err);
    // Do not fail the webhook; just log
  }

  res.json({ received: true });
}

export default router;
