// backend/src/memberships.js
import Stripe from "stripe";
import { Router } from "express";
import { pool, saveBooking } from "./db.js";
import { authMiddleware } from "./auth.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const svcByTier = { standard: "exterior", premium: "full" };
const prices = {
  standard: { intro: process.env.STANDARD_INTRO_PRICE, full: process.env.STANDARD_PRICE },
  premium:  { intro: process.env.PREMIUM_INTRO_PRICE,  full: process.env.PREMIUM_PRICE  },
};

const one = async (q,p)=> (await pool.query(q,p)).rows[0]||null;

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
     VALUES ($1,$2,2,'grant',$3,to_timestamp($4),to_timestamp($5),$6)`,
    [user_id, service_type, `grant for ${tier} invoice ${invoice_id}`, period_start, period_end, invoice_id]
  );
}

async function ensureFullPriceNextCycle(subscriptionId, tier) {
  const intro = prices[tier].intro, full = prices[tier].full;
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
  const item = sub.items.data[0];
  if (item.price.id === intro) {
    await stripe.subscriptionItems.update(item.id, { price: full, proration_behavior: "none" });
  }
}

async function revokeRemainingForInvoice({ user_id, tier, invoice_id, period_start, period_end }) {
  const service_type = svcByTier[tier];
  const g = await one(
    `SELECT COALESCE(SUM(qty),0) AS v FROM public.credit_ledger
     WHERE user_id=$1 AND service_type=$2 AND kind='grant' AND stripe_invoice_id=$3`,
    [user_id, service_type, invoice_id]
  );
  const granted = Number(g?.v || 0);
  if (granted <= 0) return;

  const u = await one(
    `SELECT COALESCE(SUM(qty),0) AS v FROM public.credit_ledger
     WHERE user_id=$1 AND service_type=$2 AND kind IN ('debit','adjust')
       AND created_at >= to_timestamp($3) AND created_at <= to_timestamp($4)`,
    [user_id, service_type, period_start, period_end]
  );
  const used = Math.abs(Number(u?.v || 0));
  const remaining = granted - used;
  if (remaining > 0) {
    await pool.query(
      `INSERT INTO public.credit_ledger (user_id, service_type, qty, kind, reason)
       VALUES ($1,$2,$3,'adjust',$4)`,
      [user_id, service_type, -remaining, `revoke remaining for refund invoice ${invoice_id}`]
    );
  }
}

/* -------- Public routes (start subscription, portal) -------- */
export function membershipRoutes() {
  const r = Router();
  r.use(authMiddleware);

  r.post("/subscribe", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ ok:false, error:"Authentication required." });
      const { tier, customer, origin } = req.body || {};
      if (!tier || !customer?.email) return res.status(400).json({ ok:false, error:"Please fill out all required fields." });
      const cfg = prices[tier]; if (!cfg?.intro || !cfg?.full) return res.status(500).json({ ok:false, error:"Membership prices are not configured." });

      const u = await one("SELECT * FROM public.users WHERE id=$1", [req.user.id]);
      await pool.query(
        `UPDATE public.users SET name=COALESCE($2,name), phone=COALESCE($3,phone),
         street=COALESCE($4,street), postcode=COALESCE($5,postcode) WHERE id=$1`,
        [u.id, customer.name||null, customer.phone||null, customer.street||null, customer.postcode||null]
      );

      const eligible = await firstTimeEligible({ email: customer.email, phone: customer.phone, street: customer.street });

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

      const successBase = (origin || process.env.PUBLIC_FRONTEND_ORIGIN || "").replace(/\/+$/,"");
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [{ price: eligible ? cfg.intro : cfg.full, quantity: 1 }],
        // flow=sub so FE shows the subscription thank-you variant
        success_url: `${successBase}/?thankyou=1&flow=sub&sub=1`,
        cancel_url:  successBase || process.env.PUBLIC_FRONTEND_ORIGIN,
        metadata: { tier, user_id: String(u.id), intro_used: String(eligible) }
      });

      console.log("[memberships] subscribe session created", JSON.stringify({
        user_id: u.id, tier, eligible, session_id: session.id, customer_id: stripeCustomerId
      }));
      res.json({ ok:true, url: session.url });
    } catch (e) {
      console.error("[memberships/subscribe]", e);
      res.status(500).json({ ok:false, error:"Unable to start subscription." });
    }
  });

  r.get("/portal", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ ok:false, error:"Authentication required." });
      const u = await one("SELECT * FROM public.users WHERE id=$1", [req.user.id]);
      if (!u?.stripe_customer_id) return res.status(400).json({ ok:false, error:"No Stripe customer found." });
      const ps = await stripe.billingPortal.sessions.create({
        customer: u.stripe_customer_id,
        return_url: (process.env.PUBLIC_FRONTEND_ORIGIN || "").replace(/\/+$/,"") + "/account.html"
      });
      res.json({ ok:true, url: ps.url });
    } catch (e) {
      console.error("[memberships/portal]", e);
      res.status(500).json({ ok:false, error:"Unable to open subscription portal." });
    }
  });

  return r;
}

/* -------- Webhook: memberships & addons-only completions -------- */
export async function membershipsWebhookHandler(req, res) {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET_MEMBERSHIPS
    );

    console.log("[memberships] webhook received", event.type);

    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;

        // A) subscription flow
        if (s.mode === "subscription") {
          const user_id = Number(s.metadata?.user_id || 0);
          const tier = s.metadata?.tier;
          const subId = s.subscription;
          console.log("[memberships] checkout.session.completed", JSON.stringify({ user_id, tier, subId, customer: s.customer }));
          if (user_id && tier && subId) {
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
          }
        }

        // B) addons-only with credit (mode=payment) handled in credits route on its own webhook,
        // but we still debit credit there after booking creation (already implemented).
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        console.log("[memberships] invoice.payment_succeeded", JSON.stringify({ invoice_id: inv.id, customer: inv.customer }));
        if (!inv.subscription) break;

        const srow = await one("SELECT * FROM public.subscriptions WHERE stripe_subscription_id=$1", [inv.subscription]);
        if (!srow) break;

        const sub = await stripe.subscriptions.retrieve(inv.subscription, { expand:["items.data.price"] });
        const p = sub.items.data[0].price.id;
        const tier = (p === prices.standard.full || p === prices.standard.intro) ? "standard" : "premium";

        const line = inv.lines?.data?.[0];
        if (line?.period) {
          await grantCreditsFromInvoice({
            user_id: srow.user_id,
            tier,
            invoice_id: inv.id,
            period_start: line.period.start,
            period_end: line.period.end
          });
          console.log("[memberships] credits granted", JSON.stringify({
            user_id: srow.user_id,
            service_type: svcByTier[tier],
            qty: 2,
            invoice_id: inv.id,
            period_start: line.period.start,
            period_end: line.period.end
          }));
        }

        if (inv.billing_reason === "subscription_create") {
          await ensureFullPriceNextCycle(inv.subscription, tier);
          await pool.query("UPDATE public.users SET membership_intro_used=TRUE WHERE id=$1", [srow.user_id]);
        }

        await upsertSubscription({
          user_id: srow.user_id,
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
        await pool.query(
          "UPDATE public.subscriptions SET status=$2, updated_at=now() WHERE stripe_subscription_id=$1",
          [sub.id, sub.status || "canceled"]
        );
        break;
      }

      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.warn("[memberships webhook] err", e?.message);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
}

/* -------- Admin: cancel+refund now (deny if credits used) -------- */
export function adminMembershipRoutes() {
  const r = Router();
  r.post("/subscriptions/:sid/cancel_refund_now", async (req, res) => {
    try {
      if (req.query.token !== process.env.ADMIN_TOKEN)
        return res.status(401).json({ ok:false, error:"unauthorized" });

      // ... unchanged admin logic ...
      res.json({ ok:true });
    } catch (e) {
      console.error("[admin cancel_refund_now]", e);
      res.status(500).json({ ok:false, error:"cancel_refund_failed" });
    }
  });
  return r;
}
