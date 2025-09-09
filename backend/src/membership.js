// backend/src/memberships.js
import Stripe from "stripe";
import { Router } from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const svcByTier = { standard: "exterior", premium: "full" };
const prices = {
  standard: { intro: process.env.STANDARD_INTRO_PRICE, full: process.env.STANDARD_PRICE },
  premium:  { intro: process.env.PREMIUM_INTRO_PRICE,  full: process.env.PREMIUM_PRICE  },
};

/* ---------- helpers ---------- */
const one = async (q,p)=> (await pool.query(q,p)).rows[0]||null;
const all = async (q,p)=> (await pool.query(q,p)).rows||[];

function norm(s){ return String(s||"").trim().toLowerCase(); }
function digits(s){ return String(s||"").replace(/[^0-9]+/g,""); }

async function firstTimeEligible({ email, phone, street }) {
  const e = norm(email), p = digits(phone), s = norm(street);
  const u = await one(
    `SELECT 1 FROM public.users WHERE
      (lower(email)=NULLIF($1,'')) OR
      (regexp_replace(phone,'[^0-9]+','','g')=regexp_replace($2,'[^0-9]+','','g') AND $2<>'') OR
      (regexp_replace(lower(street),'[^a-z0-9]+','','g')=regexp_replace($3,'[^a-z0-9]+','','g') AND $3<>'')
     LIMIT 1`, [e,p,s]);
  if (u) return false;
  const b = await one(
    `SELECT 1 FROM public.bookings WHERE
      (lower(customer_email)=NULLIF($1,'')) OR
      (regexp_replace(customer_phone,'[^0-9]+','','g')=regexp_replace($2,'[^0-9]+','','g') AND $2<>'') OR
      (regexp_replace(lower(customer_street),'[^a-z0-9]+','','g')=regexp_replace($3,'[^a-z0-9]+','','g') AND $3<>'')
     LIMIT 1`, [e,p,s]);
  return !b;
}

async function upsertSubscription({ user_id, stripe_subscription_id, tier, status, period_start, period_end }) {
  const ex = await one("SELECT id FROM public.subscriptions WHERE stripe_subscription_id=$1", [stripe_subscription_id]);
  if (ex) {
    await pool.query(
      `UPDATE public.subscriptions
       SET user_id=$2,tier=$3,status=$4,current_period_start=to_timestamp($5),current_period_end=to_timestamp($6),updated_at=now()
       WHERE stripe_subscription_id=$1`,
      [stripe_subscription_id, user_id, tier, status, period_start, period_end]
    );
  } else {
    await pool.query(
      `INSERT INTO public.subscriptions (user_id,stripe_subscription_id,tier,status,current_period_start,current_period_end)
       VALUES ($1,$2,$3,$4,to_timestamp($5),to_timestamp($6))`,
      [user_id, stripe_subscription_id, tier, status, period_start, period_end]
    );
  }
}

async function linkUserStripeCustomer(userId, stripeCustomerId) {
  await pool.query(
    "UPDATE public.users SET stripe_customer_id=$1 WHERE id=$2 AND (stripe_customer_id IS NULL OR stripe_customer_id<>$1)",
    [stripeCustomerId, userId]
  );
}

async function grantCreditsFromInvoice({ user_id, tier, invoice_id, period_start, period_end }) {
  const service_type = svcByTier[tier];
  const exists = await one(
    `SELECT 1 FROM public.credit_ledger
     WHERE user_id=$1 AND service_type=$2 AND kind='grant' AND stripe_invoice_id=$3`,
    [user_id, service_type, invoice_id]
  );
  if (exists) return;
  await pool.query(
    `INSERT INTO public.credit_ledger
     (user_id, service_type, qty, kind, reason, valid_from, valid_until, stripe_invoice_id)
     VALUES ($1,$2,$3,'grant',$4,to_timestamp($5),to_timestamp($6),$7)`,
    [user_id, service_type, 2, `grant for ${tier} invoice ${invoice_id}`, period_start, period_end, invoice_id]
  );
}

async function ensureFullPriceNextCycle(subscriptionId, tier) {
  const { intro, full } = prices[tier];
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
  const item = sub.items.data[0];
  if (item.price.id === intro) {
    await stripe.subscriptionItems.update(item.id, { price: full, proration_behavior: "none" });
  }
}

async function revokeRemainingForInvoice({ user_id, tier, invoice_id, period_start, period_end }) {
  const service_type = svcByTier[tier];
  const grantRow = await one(
    `SELECT COALESCE(SUM(qty),0) AS g
     FROM public.credit_ledger WHERE user_id=$1 AND service_type=$2 AND kind='grant' AND stripe_invoice_id=$3`,
    [user_id, service_type, invoice_id]
  );
  const granted = Number(grantRow?.g || 0);
  if (granted <= 0) return;

  const usedRow = await one(
    `SELECT COALESCE(SUM(qty),0) AS u
     FROM public.credit_ledger
     WHERE user_id=$1 AND service_type=$2 AND kind IN ('debit','adjust')
       AND created_at >= to_timestamp($3) AND created_at <= to_timestamp($4)`,
    [user_id, service_type, period_start, period_end]
  );
  const used = Math.abs(Number(usedRow?.u || 0));
  const remaining = granted - used;
  if (remaining > 0) {
    await pool.query(
      `INSERT INTO public.credit_ledger (user_id, service_type, qty, kind, reason)
       VALUES ($1,$2,$3,'adjust',$4)`,
      [user_id, service_type, -remaining, `revoke remaining for refund invoice ${invoice_id}`]
    );
  }
}

/* ---------- Public routes ---------- */
export function membershipRoutes() {
  const r = Router();
  r.use(authMiddleware);

  // Start subscription (server chooses intro vs full)
  r.post("/subscribe", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });
      const { tier, customer, origin } = req.body || {};
      if (!tier || !customer?.email) return res.status(400).json({ ok:false, error:"missing_fields" });
      const cfg = prices[tier]; if (!cfg?.intro || !cfg?.full) return res.status(500).json({ ok:false, error:"price_env_missing" });

      // load user
      const u = await one("SELECT * FROM public.users WHERE id=$1", [req.user.id]);
      if (!u) return res.status(401).json({ ok:false, error:"auth_required" });

      // save latest profile (optional)
      await pool.query(
        `UPDATE public.users SET name=COALESCE($2,name), phone=COALESCE($3,phone),
         street=COALESCE($4,street), postcode=COALESCE($5,postcode) WHERE id=$1`,
        [u.id, customer.name||null, customer.phone||null, customer.street||null, customer.postcode||null]
      );

      // determine intro eligibility (street OR phone OR email has never appeared)
      const eligible = await firstTimeEligible({ email: customer.email, phone: customer.phone, street: customer.street });

      // ensure stripe customer
      let stripeCustomerId = u.stripe_customer_id;
      if (!stripeCustomerId) {
        const sc = await stripe.customers.create({
          email: customer.email,
          name: customer.name || undefined,
          address: { line1: customer.street || undefined, postal_code: customer.postcode || undefined }
        });
        stripeCustomerId = sc.id;
        await linkUserStripeCustomer(u.id, sc.id);
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [{ price: eligible ? cfg.intro : cfg.full, quantity: 1 }],
        success_url: `${(origin || process.env.PUBLIC_FRONTEND_ORIGIN)}/account?sub=1`,
        cancel_url:  (origin || process.env.PUBLIC_FRONTEND_ORIGIN),
        metadata: { tier, user_id: String(u.id), intro_used: String(eligible) }
      });

      res.json({ ok:true, url: session.url });
    } catch (e) {
      console.error("[memberships/subscribe]", e);
      res.status(500).json({ ok:false, error:"subscribe_failed" });
    }
  });

  // Customer portal
  r.get("/portal", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });
      const u = await one("SELECT * FROM public.users WHERE id=$1", [req.user.id]);
      if (!u?.stripe_customer_id) return res.status(400).json({ ok:false, error:"no_stripe_customer" });
      const ps = await stripe.billingPortal.sessions.create({
        customer: u.stripe_customer_id,
        return_url: process.env.PUBLIC_FRONTEND_ORIGIN
      });
      res.json({ ok:true, url: ps.url });
    } catch (e) {
      console.error("[memberships/portal]", e);
      res.status(500).json({ ok:false, error:"portal_failed" });
    }
  });

  return r;
}

/* ---------- Admin cancel+refund now (refuse if credits used) ---------- */
export function adminMembershipRoutes() {
  const r = Router();
  r.post("/subscriptions/:sid/cancel_refund_now", async (req, res) => {
    try {
      if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
      const sid = req.params.sid;
      const sub = await stripe.subscriptions.retrieve(sid, { expand:["latest_invoice.payment_intent","items.data.price"] });
      const tier = (sub.items.data[0].price.id === prices.standard.full || sub.items.data[0].price.id === prices.standard.intro) ? "standard" : "premium";
      const start = sub.current_period_start, end = sub.current_period_end;

      const srow = await one("SELECT * FROM public.subscriptions WHERE stripe_subscription_id=$1", [sid]);
      if (!srow) return res.status(404).json({ ok:false, error:"sub_not_found" });

      const grantedRow = await one(
        `SELECT COALESCE(SUM(qty),0) AS g FROM public.credit_ledger
         WHERE user_id=$1 AND service_type=$2 AND kind='grant'
           AND valid_from=to_timestamp($3) AND valid_until=to_timestamp($4)`,
        [srow.user_id, svcByTier[tier], start, end]
      );
      const granted = Number(grantedRow?.g || 0);
      const usedRow = await one(
        `SELECT COALESCE(SUM(qty),0) AS u FROM public.credit_ledger
         WHERE user_id=$1 AND service_type=$2 AND kind IN ('debit','adjust')
           AND created_at >= to_timestamp($3) AND created_at <= to_timestamp($4)`,
        [srow.user_id, svcByTier[tier], start, end]
      );
      const used = Math.abs(Number(usedRow?.u || 0));
      if (used > 0) return res.status(409).json({ ok:false, error:"credits_already_used" });

      const invId = sub.latest_invoice;
      const inv = await stripe.invoices.retrieve(invId, { expand:["payment_intent","charge"] });
      if (!inv?.paid || !inv.charge) return res.status(400).json({ ok:false, error:"no_paid_charge" });

      await stripe.refunds.create({ charge: inv.charge.id });

      if (granted > 0) {
        await pool.query(
          `INSERT INTO public.credit_ledger (user_id, service_type, qty, kind, reason)
           VALUES ($1,$2,$3,'adjust',$4)`,
          [srow.user_id, svcByTier[tier], -granted, `admin refund invoice ${invId}`]
        );
      }
      await stripe.subscriptions.cancel(sid, { invoice_now:false, prorate:false });
      await pool.query("UPDATE public.subscriptions SET status='canceled', updated_at=now() WHERE stripe_subscription_id=$1", [sid]);

      res.json({ ok:true });
    } catch (e) {
      console.error("[admin cancel_refund_now]", e);
      res.status(500).json({ ok:false, error:"cancel_refund_failed" });
    }
  });
  return r;
}

/* ---------- Webhook endpoint (separate URL) ---------- */
export async function membershipsWebhookHandler(req, res) {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET_MEMBERSHIPS);

    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        if (s.mode !== "subscription") break;
        const user_id = Number(s.metadata?.user_id || 0);
        const tier = s.metadata?.tier;
        const subId = s.subscription;
        if (!user_id || !tier || !subId) break;

        const sub = await stripe.subscriptions.retrieve(subId);
        await upsertSubscription({
          user_id,
          stripe_subscription_id: subId,
          tier,
          status: sub.status,
          period_start: sub.current_period_start,
          period_end: sub.current_period_end
        });
        if (s.customer) await linkUserStripeCustomer(user_id, s.customer);
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        if (!inv.subscription) break;
        const subRow = await one("SELECT * FROM public.subscriptions WHERE stripe_subscription_id=$1", [inv.subscription]);
        if (!subRow) break;

        // Determine tier by price id at time of event
        const sub = await stripe.subscriptions.retrieve(inv.subscription, { expand:["items.data.price"] });
        const p = sub.items.data[0].price.id;
        const tier = (p === prices.standard.full || p === prices.standard.intro) ? "standard" : "premium";

        const line = inv.lines?.data?.[0];
        if (line?.period) {
          await grantCreditsFromInvoice({
            user_id: subRow.user_id, tier, invoice_id: inv.id,
            period_start: line.period.start, period_end: line.period.end
          });
        }

        if (inv.billing_reason === "subscription_create") {
          await ensureFullPriceNextCycle(inv.subscription, tier);
          await pool.query("UPDATE public.users SET membership_intro_used=TRUE WHERE id=$1", [subRow.user_id]);
        }

        await upsertSubscription({
          user_id: subRow.user_id,
          stripe_subscription_id: inv.subscription,
          tier,
          status: sub.status,
          period_start: sub.current_period_start,
          period_end: sub.current_period_end
        });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await pool.query("UPDATE public.subscriptions SET status=$2, updated_at=now() WHERE stripe_subscription_id=$1", [sub.id, sub.status || "canceled"]);
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object;
        const invId = typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id;
        if (!invId) break;
        const inv = await stripe.invoices.retrieve(invId);
        if (!inv?.subscription) break;

        const subRow = await one("SELECT * FROM public.subscriptions WHERE stripe_subscription_id=$1", [inv.subscription]);
        if (!subRow) break;

        const line = inv.lines?.data?.[0];
        if (!line?.period) break;

        const sub = await stripe.subscriptions.retrieve(inv.subscription, { expand:["items.data.price"] });
        const p = sub.items.data[0].price.id;
        const tier = (p === prices.standard.full || p === prices.standard.intro) ? "standard" : "premium";

        await revokeRemainingForInvoice({
          user_id: subRow.user_id, tier, invoice_id: invId,
          period_start: line.period.start, period_end: line.period.end
        });
        break;
      }

      default:
        // ignore
        break;
    }
    return res.json({ received: true });
  } catch (e) {
    console.warn("[memberships webhook] err", e?.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
}
