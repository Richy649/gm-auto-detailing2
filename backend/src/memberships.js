// backend/src/memberships.js
import Stripe from "stripe";
import { Router } from "express";
import { pool, saveBooking } from "./db.js";
import { authMiddleware } from "./auth.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// map tiers -> service_type used in credit_ledger
const svcByTier = { standard: "exterior", premium: "full" };

// Price IDs from env (must be the *Price IDs*, not Product IDs)
const prices = {
  standard: {
    intro: process.env.STANDARD_INTRO_PRICE,
    full:  process.env.STANDARD_PRICE,
  },
  premium: {
    intro: process.env.PREMIUM_INTRO_PRICE,
    full:  process.env.PREMIUM_PRICE,
  },
};

const one = async (q, p) => (await pool.query(q, p)).rows[0] || null;
const safeJson = (x) => { try { return JSON.stringify(x); } catch { return String(x); } };

function norm(s){ return String(s||"").trim().toLowerCase(); }
function digits(s){ return String(s||"").replace(/[^0-9]+/g,""); }

/* ------------------------------------------------------------
   First-time eligibility for intro month (by address/phone/email)
   ------------------------------------------------------------ */
async function firstTimeEligible({ email, phone, street }) {
  try {
    const e = norm(email), p = digits(phone), s = norm(street);

    const u = await one(
      `SELECT 1 FROM public.users
        WHERE (lower(email) = NULLIF($1,''))
           OR (regexp_replace(phone,'[^0-9]+','','g') = regexp_replace($2,'[^0-9]+','','g') AND $2 <> '')
           OR (regexp_replace(lower(street),'[^a-z0-9]+','','g') = regexp_replace($3,'[^a-z0-9]+','','g') AND $3 <> '')
       LIMIT 1`,
      [e, p, s]
    );
    if (u) return false;

    const b = await one(
      `SELECT 1 FROM public.bookings
        WHERE (lower(customer_email) = NULLIF($1,''))
           OR (regexp_replace(customer_phone,'[^0-9]+','','g') = regexp_replace($2,'[^0-9]+','','g') AND $2 <> '')
           OR (regexp_replace(lower(customer_street),'[^a-z0-9]+','','g') = regexp_replace($3,'[^a-z0-9]+','','g') AND $3 <> '')
       LIMIT 1`,
      [e, p, s]
    );
    return !b;
  } catch (err) {
    console.warn("[memberships] firstTimeEligible error -> treating as eligible", err?.message);
    return true;
  }
}

/* ------------------------------------------------------------
   Subscription row upsert
   ------------------------------------------------------------ */
async function upsertSubscription({ user_id, stripe_subscription_id, tier, status, period_start, period_end }) {
  const ex = await one("SELECT id FROM public.subscriptions WHERE stripe_subscription_id=$1", [stripe_subscription_id]);
  if (ex) {
    await pool.query(
      `UPDATE public.subscriptions
         SET user_id=$2,
             tier=$3,
             status=$4,
             current_period_start=to_timestamp($5),
             current_period_end=to_timestamp($6),
             updated_at=now()
       WHERE stripe_subscription_id=$1`,
      [stripe_subscription_id, user_id, tier, status, period_start, period_end]
    );
  } else {
    await pool.query(
      `INSERT INTO public.subscriptions
        (user_id,stripe_subscription_id,tier,status,current_period_start,current_period_end)
       VALUES ($1,$2,$3,$4,to_timestamp($5),to_timestamp($6))`,
      [user_id, stripe_subscription_id, tier, status, period_start, period_end]
    );
  }
}

/* ------------------------------------------------------------
   Link user <-> stripe customer
   ------------------------------------------------------------ */
async function linkUserStripeCustomer(userId, stripeCustomerId) {
  await pool.query(
    "UPDATE public.users SET stripe_customer_id=$1 WHERE id=$2 AND (stripe_customer_id IS NULL OR stripe_customer_id<>$1)",
    [stripeCustomerId, userId]
  );
}

/* ------------------------------------------------------------
   Credit ledger operations
   ------------------------------------------------------------ */
async function grantCreditsFromInvoice({ user_id, tier, invoice_id, period_start, period_end }) {
  const service_type = svcByTier[tier];
  if (!service_type) {
    console.warn("[memberships] grantCreditsFromInvoice unknown tier", tier);
    return;
  }

  const exists = await one(
    `SELECT 1 FROM public.credit_ledger
       WHERE user_id=$1 AND service_type=$2 AND kind='grant' AND stripe_invoice_id=$3`,
    [user_id, service_type, invoice_id]
  );
  if (exists) {
    console.log("[memberships] credits already granted for invoice", invoice_id);
    return;
  }

  await pool.query(
    `INSERT INTO public.credit_ledger
       (user_id, service_type, qty, kind, reason, valid_from, valid_until, stripe_invoice_id)
     VALUES ($1,$2,2,'grant',$3,to_timestamp($4),to_timestamp($5),$6)`,
    [user_id, service_type, `grant for ${tier} invoice ${invoice_id}`, period_start, period_end, invoice_id]
  );

  console.log("[memberships] credits granted",
    safeJson({ user_id, service_type, qty: 2, invoice_id, period_start, period_end })
  );
}

async function revokeRemainingForInvoice({ user_id, tier, invoice_id, period_start, period_end }) {
  const service_type = svcByTier[tier];
  const g = await one(
    `SELECT COALESCE(SUM(qty),0) AS v
       FROM public.credit_ledger
      WHERE user_id=$1 AND service_type=$2 AND kind='grant' AND stripe_invoice_id=$3`,
    [user_id, service_type, invoice_id]
  );
  const granted = Number(g?.v || 0);
  if (granted <= 0) return;

  const u = await one(
    `SELECT COALESCE(SUM(qty),0) AS v
       FROM public.credit_ledger
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
    console.log("[memberships] credits revoked",
      safeJson({ user_id, service_type, remaining, invoice_id })
    );
  }
}

/* ------------------------------------------------------------
   Price helpers
   ------------------------------------------------------------ */
function tierFromPriceId(priceId) {
  if (!priceId) return null;
  if (priceId === prices.standard.intro || priceId === prices.standard.full) return "standard";
  if (priceId === prices.premium.intro  || priceId === prices.premium.full)  return "premium";
  return null;
}

async function ensureFullPriceNextCycle(subscriptionId, tier) {
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
    const item = sub.items.data[0];
    if (!item?.price?.id) return;
    if (tierFromPriceId(item.price.id) && item.price.id === prices[tier].intro) {
      await stripe.subscriptionItems.update(item.id, { price: prices[tier].full, proration_behavior: "none" });
      console.log("[memberships] switched to full price for next cycle", safeJson({ subscriptionId, tier }));
    }
  } catch (e) {
    console.warn("[memberships] ensureFullPriceNextCycle failed", e?.message);
  }
}

/* ------------------------------------------------------------
   Public routes (start subscription, portal)
   ------------------------------------------------------------ */
export function membershipRoutes() {
  const r = Router();
  r.use(authMiddleware);

  r.post("/subscribe", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });
      const { tier, customer, origin } = req.body || {};
      if (!tier || !customer?.email) return res.status(400).json({ ok:false, error:"missing_fields" });
      const cfg = prices[tier]; if (!cfg?.intro || !cfg?.full) return res.status(500).json({ ok:false, error:"price_env_missing" });

      const u = await one("SELECT * FROM public.users WHERE id=$1", [req.user.id]);

      await pool.query(
        `UPDATE public.users
            SET name=COALESCE(NULLIF($2,''),name),
                phone=COALESCE(NULLIF($3,''),phone),
                street=COALESCE(NULLIF($4,''),street),
                postcode=COALESCE(NULLIF($5,''),postcode),
                updated_at=now()
          WHERE id=$1`,
        [u.id, customer.name||"", customer.phone||"", customer.street||"", customer.postcode||""]
      );

      const eligible = await firstTimeEligible({
        email: customer.email, phone: customer.phone, street: customer.street
      });

      let stripeCustomerId = u.stripe_customer_id;
      if (!stripeCustomerId) {
        const sc = await stripe.customers.create({
          email: customer.email,
          name: customer.name || undefined,
          address: { line1: customer.street || undefined, postal_code: customer.postcode || undefined }
        });
        stripeCustomerId = sc.id;
        await linkUserStripeCustomer(u.id, sc.id);
        console.log("[memberships] created stripe customer", safeJson({ user_id: u.id, customer_id: sc.id }));
      } else {
        try { await stripe.customers.retrieve(stripeCustomerId); }
        catch {
          const sc = await stripe.customers.create({
            email: customer.email,
            name: customer.name || undefined,
            address: { line1: customer.street || undefined, postal_code: customer.postcode || undefined }
          });
          stripeCustomerId = sc.id;
          await linkUserStripeCustomer(u.id, sc.id);
          console.log("[memberships] repaired missing stripe customer", safeJson({ user_id: u.id, customer_id: sc.id }));
        }
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [{ price: eligible ? cfg.intro : cfg.full, quantity: 1 }],
        success_url: `${(origin || process.env.PUBLIC_FRONTEND_ORIGIN || "").replace(/\/+$/,"")}/account.html?sub=1`,
        cancel_url:  (origin || process.env.PUBLIC_FRONTEND_ORIGIN || ""),
        metadata: { tier, user_id: String(u.id), intro_used: String(eligible) }
      });

      console.log("[memberships] subscribe session created", safeJson({
        user_id: u.id, tier, eligible, session_id: session.id, customer_id: stripeCustomerId
      }));

      res.json({ ok:true, url: session.url });
    } catch (e) {
      console.error("[memberships/subscribe] error", e);
      res.status(500).json({ ok:false, error:"subscribe_failed" });
    }
  });

  r.get("/portal", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });
      const u = await one("SELECT * FROM public.users WHERE id=$1", [req.user.id]);
      if (!u?.stripe_customer_id) return res.status(400).json({ ok:false, error:"no_stripe_customer" });
      const ps = await stripe.billingPortal.sessions.create({
        customer: u.stripe_customer_id,
        return_url: (process.env.PUBLIC_FRONTEND_ORIGIN || "").replace(/\/+$/,"") + "/account.html"
      });
      res.json({ ok:true, url: ps.url });
    } catch (e) {
      console.error("[memberships/portal] error", e);
      res.status(500).json({ ok:false, error:"portal_failed" });
    }
  });

  return r;
}

/* ------------------------------------------------------------
   Webhook handler
   ------------------------------------------------------------ */
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

        if (s.mode === "subscription") {
          const user_id = Number(s.metadata?.user_id || 0);
          const tier = s.metadata?.tier;
          const subId = s.subscription;
          console.log("[memberships] checkout.session.completed", safeJson({ user_id, tier, subId, customer: s.customer }));

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

        if (s.mode === "payment" && s.metadata?.kind === "addons_only_with_credit") {
          const user_id = Number(s.metadata.user_id || 0);
          const service_key = s.metadata.service_key;
          const start_iso = s.metadata.start_iso;
          const end_iso = s.metadata.end_iso;
          const addons = JSON.parse(s.metadata.addons || "[]");
          const customer = JSON.parse(s.metadata.customer || "{}");
          const bookingId = await saveBooking({
            user_id,
            stripe_session_id: s.id, service_key, addons, start_iso, end_iso, customer, has_tap: true
          });
          const service_type = service_key === "full" ? "full" : "exterior";
          await pool.query(
            `INSERT INTO public.credit_ledger (user_id, service_type, qty, kind, reason, related_booking_id)
             VALUES ($1,$2,-1,'debit',$3,$4)`,
            [user_id, service_type, `booking ${bookingId}`, bookingId]
          );
          console.log("[memberships] debit 1 credit for addons-only booking", safeJson({ user_id, service_type, bookingId }));
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const rawInv = event.data.object;
        console.log("[memberships] invoice.payment_succeeded", safeJson({ invoice_id: rawInv.id, customer: rawInv.customer }));

        // Re-retrieve invoice with expansions to make sure we have subscription and price details.
        const inv = await stripe.invoices.retrieve(rawInv.id, {
          expand: ["subscription", "lines.data.price", "lines.data.subscription_item"]
        });

        // Try to resolve subscription id
        let subscriptionId =
          (typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id) ||
          inv.lines?.data?.[0]?.subscription ||
          null;

        // If still missing, derive from customer's active subscriptions
        if (!subscriptionId) {
          const custId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
          if (custId) {
            const subs = await stripe.subscriptions.list({ customer: custId, status: "active", limit: 3 });
            if (subs?.data?.length) subscriptionId = subs.data[0].id;
          }
        }

        if (!subscriptionId) {
          console.warn("[memberships] invoice has no resolvable subscription; skipping grant", safeJson({ invoice_id: inv.id }));
          break;
        }

        // Pull subscription and infer tier from price id
        const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
        const priceId = sub.items.data[0]?.price?.id || inv.lines?.data?.[0]?.price?.id || null;

        let tier = tierFromPriceId(priceId);
        if (!tier) {
          // final fallback
          const unitAmount = sub.items.data[0]?.price?.unit_amount || inv.lines?.data?.[0]?.price?.unit_amount || 0;
          if (unitAmount) {
            // Compare to known full/intro amounts if you want; here we default to standard
            tier = "standard";
          } else {
            tier = "standard";
          }
        }

        // Find or build subscription row and user_id
        let srow = await one("SELECT * FROM public.subscriptions WHERE stripe_subscription_id=$1", [subscriptionId]);
        let user_id = srow?.user_id || null;

        if (!user_id) {
          const custId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
          const u = custId ? await one("SELECT id FROM public.users WHERE stripe_customer_id=$1", [custId]) : null;
          if (u?.id) {
            user_id = u.id;
            await upsertSubscription({
              user_id,
              stripe_subscription_id: subscriptionId,
              tier,
              status: sub.status,
              period_start: sub.current_period_start,
              period_end: sub.current_period_end
            });
            srow = await one("SELECT * FROM public.subscriptions WHERE stripe_subscription_id=$1", [subscriptionId]);
            console.log("[memberships] reconstructed subscription row", safeJson({ user_id, tier }));
          }
        }

        if (!srow?.user_id) {
          console.warn("[memberships] invoice paid but no subscription/user found; skipping grant", safeJson({ invoice_id: inv.id }));
          break;
        }

        // Determine period bounds (prefer invoice line period)
        const line = inv.lines?.data?.[0];
        const pStart = line?.period?.start || sub.current_period_start;
        const pEnd   = line?.period?.end   || sub.current_period_end;

        await grantCreditsFromInvoice({
          user_id: srow.user_id,
          tier,
          invoice_id: inv.id,
          period_start: pStart,
          period_end: pEnd
        });

        if (inv.billing_reason === "subscription_create") {
          await ensureFullPriceNextCycle(subscriptionId, tier);
          await pool.query("UPDATE public.users SET membership_intro_used=TRUE WHERE id=$1", [srow.user_id])
            .catch((e)=> console.warn("[memberships] failed to mark membership_intro_used", e?.message));
        }

        await upsertSubscription({
          user_id: srow.user_id,
          stripe_subscription_id: subscriptionId,
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
        console.log("[memberships] subscription deleted", safeJson({ subscription: sub.id, status: sub.status }));
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object;
        const invId = typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id;
        if (!invId) break;
        const inv = await stripe.invoices.retrieve(invId, { expand:["subscription","lines.data.price"] });
        const subId = (typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id) || null;
        if (!subId) break;

        const srow = await one("SELECT * FROM public.subscriptions WHERE stripe_subscription_id=$1", [subId]);
        if (!srow) break;

        const sub = await stripe.subscriptions.retrieve(subId, { expand:["items.data.price"] });
        const activePriceId = sub.items.data[0]?.price?.id || null;
        const tier = tierFromPriceId(activePriceId) || "standard";

        const line = inv.lines?.data?.[0];
        if (!line?.period) break;

        await revokeRemainingForInvoice({
          user_id: srow.user_id,
          tier,
          invoice_id: invId,
          period_start: line.period.start,
          period_end: line.period.end
        });
        console.log("[memberships] charge refunded -> adjusted credits", safeJson({ user_id: srow.user_id, invoice: invId }));
        break;
      }

      default:
        console.log("[memberships] webhook unhandled type", event.type);
        break;
    }

    res.json({ received: true });
  } catch (e) {
    console.warn("[memberships webhook] err", e?.message);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
}

/* ------------------------------------------------------------
   Admin: cancel+refund now (deny if credits used)
   ------------------------------------------------------------ */
export function adminMembershipRoutes() {
  const r = Router();

  r.post("/subscriptions/:sid/cancel_refund_now", async (req, res) => {
    try {
      if (req.query.token !== process.env.ADMIN_TOKEN)
        return res.status(401).json({ ok:false, error:"unauthorized" });

      const sid = req.params.sid;
      const sub = await stripe.subscriptions.retrieve(sid, { expand:["latest_invoice.payment_intent","items.data.price"] });

      const activePriceId = sub.items.data[0]?.price?.id || null;
      const tier = tierFromPriceId(activePriceId) || "standard";
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

      console.log("[memberships] admin cancel_refund_now", safeJson({ sid, user_id: srow.user_id, granted, used }));
      res.json({ ok:true });
    } catch (e) {
      console.error("[admin cancel_refund_now]", e);
      res.status(500).json({ ok:false, error:"cancel_refund_failed" });
    }
  });

  return r;
}
