// backend/src/memberships.js
import Stripe from "stripe";
import { Router } from "express";
import { pool, saveBooking } from "./db.js";
import { authMiddleware } from "./auth.js";
import { createCalendarEvents } from "./gcal.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const svcByTier = { standard: "exterior", premium: "full" };
const prices = {
  standard: { intro: process.env.STANDARD_INTRO_PRICE, full: process.env.STANDARD_PRICE },
  premium:  { intro: process.env.PREMIUM_INTRO_PRICE,  full: process.env.PREMIUM_PRICE  },
};

const one = async (q,p)=> (await pool.query(q,p)).rows[0]||null;

function norm(s){ return String(s||"").trim().toLowerCase(); }
function digits(s){ return String(s||"").replace(/[^0-9]+/g,""); }

/* ---------------- epoch helpers ---------------- */
function asEpochSec(v) {
  // Accept numeric epoch seconds, numeric strings; otherwise null
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}
function pickPeriod({ linePeriod, sub }) {
  // Prefer line period; fall back to subscription current period
  const start = asEpochSec(linePeriod?.start) ?? asEpochSec(sub?.current_period_start) ?? null;
  const end   = asEpochSec(linePeriod?.end)   ?? asEpochSec(sub?.current_period_end)   ?? null;
  return { start, end };
}

/* ---------------- intro eligibility ---------------- */
/**
 * INTRO price eligibility:
 *  - Not blocked merely by having a user account.
 *  - Block if user already used intro (membership_intro_used = true).
 *  - Block if any prior bookings exist by email/phone/street.
 */
async function firstTimeEligibleByHistory({ user_id, email, phone, street }) {
  const u = await one("SELECT membership_intro_used FROM public.users WHERE id=$1", [user_id]);
  if (u && u.membership_intro_used) return false;

  const e = norm(email), p = digits(phone), s = norm(street);
  const b = await one(
    `SELECT 1 FROM public.bookings WHERE
      (lower(customer_email)=NULLIF($1,'')) OR
      (regexp_replace(customer_phone,'[^0-9]+','','g')=regexp_replace($2,'[^0-9]+','','g') AND $2<>'') OR
      (regexp_replace(lower(customer_street),'[^a-z0-9]+','','g')=regexp_replace($3,'[^a-z0-9]+','','g') AND $3<>'')
     LIMIT 1`, [e,p,s]);
  if (b) return false;

  return true;
}

/* ---------------- subscription persistence ---------------- */
async function upsertSubscription({ user_id, stripe_subscription_id, tier, status, period_start, period_end }) {
  const ex = await one("SELECT id FROM public.subscriptions WHERE stripe_subscription_id=$1", [stripe_subscription_id]);
  if (ex) {
    await pool.query(
      `UPDATE public.subscriptions
       SET user_id=$2,tier=$3,status=$4,
           current_period_start=to_timestamp($5),current_period_end=to_timestamp($6),updated_at=now()
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

/* ---------------- stripe customer self-heal ---------------- */
async function linkUserStripeCustomer(userId, stripeCustomerId) {
  await pool.query(
    "UPDATE public.users SET stripe_customer_id=$1 WHERE id=$2 AND (stripe_customer_id IS NULL OR stripe_customer_id<>$1)",
    [stripeCustomerId, userId]
  );
}
async function getOrCreateCustomerSafely({ user, customerPayload }) {
  if (user.stripe_customer_id) {
    try {
      const sc = await stripe.customers.retrieve(user.stripe_customer_id);
      if (sc && !sc.deleted) return sc.id;
    } catch (e) {
      const code = e?.code || e?.raw?.code;
      if (code !== "resource_missing") {
        console.warn("[memberships] retrieve customer failed:", e?.message || e);
      }
    }
  }
  const created = await stripe.customers.create({
    email: customerPayload.email,
    name: customerPayload.name || undefined,
    address: {
      line1: customerPayload.street || undefined,
      postal_code: customerPayload.postcode || undefined
    }
  });
  await linkUserStripeCustomer(user.id, created.id);
  return created.id;
}

/* ---------------- credit ledger ops ---------------- */
async function grantCreditsFromInvoice({ user_id, tier, invoice_id, period_start, period_end }) {
  // Guard against empty/invalid epochs; pass nulls rather than empty strings.
  const ps = asEpochSec(period_start);
  const pe = asEpochSec(period_end);

  const service_type = svcByTier[tier];
  const exists = await one(
    `SELECT 1 FROM public.credit_ledger
     WHERE user_id=$1 AND service_type=$2 AND kind='grant' AND stripe_invoice_id=$3`,
    [user_id, service_type, invoice_id]
  );
  if (exists) return;

  console.log("[credits] grant", { user_id, tier, invoice_id, start: ps, end: pe });

  await pool.query(
    `INSERT INTO public.credit_ledger
     (user_id, service_type, qty, kind, reason, valid_from, valid_until, stripe_invoice_id)
     VALUES ($1,$2,2,'grant',$3,
             ${ps!=null ? "to_timestamp($4)" : "NULL"},
             ${pe!=null ? "to_timestamp($5)" : "NULL"},
             $6)`,
    // When ps/pe are null, the placeholders $4/$5 are still present in array;
    // We align parameters to avoid mismatch.
    ps!=null && pe!=null
      ? [user_id, service_type, `grant for ${tier} invoice ${invoice_id}`, ps, pe, invoice_id]
      : ps!=null
        ? [user_id, service_type, `grant for ${tier} invoice ${invoice_id}`, ps, null, invoice_id]
        : pe!=null
          ? [user_id, service_type, `grant for ${tier} invoice ${invoice_id}`, null, pe, invoice_id]
          : [user_id, service_type, `grant for ${tier} invoice ${invoice_id}`, null, null, invoice_id]
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
  const ps = asEpochSec(period_start);
  const pe = asEpochSec(period_end);
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
       AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
       AND ($4::timestamptz IS NULL OR created_at <= $4::timestamptz)`,
    [
      user_id,
      service_type,
      ps != null ? new Date(ps * 1000).toISOString() : null,
      pe != null ? new Date(pe * 1000).toISOString() : null
    ]
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

/* ---------------- public routes ---------------- */
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

      // Ensure a valid Stripe customer in the current mode
      const stripeCustomerId = await getOrCreateCustomerSafely({
        user: u,
        customerPayload: {
          email: customer.email,
          name: customer.name || "",
          street: customer.street || "",
          postcode: customer.postcode || ""
        }
      });

      // Keep latest profile on file
      await pool.query(
        `UPDATE public.users SET name=COALESCE($2,name), phone=COALESCE($3,phone),
         street=COALESCE($4,street), postcode=COALESCE($5,postcode) WHERE id=$1`,
        [u.id, customer.name||null, customer.phone||null, customer.street||null, customer.postcode||null]
      );

      // Determine intro eligibility by actual history
      const eligible = await firstTimeEligibleByHistory({
        user_id: u.id,
        email: customer.email,
        phone: customer.phone,
        street: customer.street
      });

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [{ price: eligible ? cfg.intro : cfg.full, quantity: 1 }],
        success_url: `${(origin || process.env.PUBLIC_FRONTEND_ORIGIN)}/account.html?sub=1`,
        cancel_url:  (origin || process.env.PUBLIC_FRONTEND_ORIGIN),
        metadata: { tier, user_id: String(u.id), intro_used: String(eligible) }
      });

      res.json({ ok:true, url: session.url });
    } catch (e) {
      console.error("[memberships/subscribe]", e);
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
        return_url: process.env.PUBLIC_FRONTEND_ORIGIN + "/account.html"
      });
      res.json({ ok:true, url: ps.url });
    } catch (e) {
      console.error("[memberships/portal]", e);
      res.status(500).json({ ok:false, error:"portal_failed" });
    }
  });

  return r;
}

/* ---------------- webhook handler ---------------- */
export async function membershipsWebhookHandler(req, res) {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(
      req.body, // RAW body (Buffer) – provided by express.raw() in server.js
      sig,
      process.env.STRIPE_WEBHOOK_SECRET_MEMBERSHIPS
    );

    // Guard against live/test mismatch
    const isLiveKey = (process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live_");
    if (typeof event.livemode === "boolean" && event.livemode !== isLiveKey) {
      console.warn("[memberships webhook] mode mismatch; dropping event");
      return res.status(400).send("Mode mismatch");
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;

        // Subscription flow
        if (s.mode === "subscription") {
          const user_id = Number(s.metadata?.user_id || 0);
          const tier = s.metadata?.tier;
          const subId = s.subscription;
          if (user_id && tier && subId) {
            const sub = await stripe.subscriptions.retrieve(subId);
            // Persist sub record w/ current period
            await upsertSubscription({
              user_id,
              stripe_subscription_id: subId,
              tier,
              status: sub.status,
              period_start: asEpochSec(sub.current_period_start),
              period_end: asEpochSec(sub.current_period_end)
            });
            if (s.customer) await linkUserStripeCustomer(user_id, s.customer);
          }
          break;
        }

        // Addons-only with credit (mode=payment)
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

          try {
            await createCalendarEvents(s.id, [{
              start_iso, end_iso,
              summary: `GM Auto Detailing — ${(service_key==="full"?"Full Detail":"Exterior Detail")}`,
              location: `${customer?.street||""}, ${customer?.postcode||""}`.trim(),
              description: [
                `Name: ${customer?.name||""}`,
                `Phone: ${customer?.phone||""}`,
                `Email: ${customer?.email||""}`,
                (addons?.length ? `Add-ons: ${addons.join(", ")}` : null),
                `Stripe session: ${s.id}`,
              ].filter(Boolean).join("\n"),
            }]);
          } catch (e) {
            console.warn("[gcal] addons+credit calendar create failed", e?.message || e);
          }
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        if (!inv.subscription) break;

        // Get subscription (for current period fallback) and tier
        const sub = await stripe.subscriptions.retrieve(inv.subscription, { expand:["items.data.price"] });
        const priceId = sub.items.data[0].price.id;
        const tier =
          (priceId === prices.standard.full || priceId === prices.standard.intro) ? "standard" : "premium";

        const srow = await one("SELECT * FROM public.subscriptions WHERE stripe_subscription_id=$1", [inv.subscription]);
        if (!srow) {
          // Ensure we have a row; then continue
          await upsertSubscription({
            user_id: Number(inv.customer_details?.metadata?.user_id || srow?.user_id || 0) || 0,
            stripe_subscription_id: inv.subscription,
            tier,
            status: sub.status,
            period_start: asEpochSec(sub.current_period_start),
            period_end: asEpochSec(sub.current_period_end)
          });
        }

        // Prefer invoice line period; fallback to sub current period
        const line = inv.lines?.data?.[0];
        const { start: pStart, end: pEnd } = pickPeriod({ linePeriod: line?.period, sub });

        // Grant 2 credits for the cycle
        await grantCreditsFromInvoice({
          user_id: srow?.user_id || (await one("SELECT user_id FROM public.subscriptions WHERE stripe_subscription_id=$1", [inv.subscription]))?.user_id || 0,
          tier,
          invoice_id: inv.id,
          period_start: pStart,
          period_end: pEnd
        });

        // If this invoice was the initial create, mark intro-used and switch next cycle to full price
        if (inv.billing_reason === "subscription_create") {
          await ensureFullPriceNextCycle(inv.subscription, tier);
          if (srow?.user_id) {
            await pool.query("UPDATE public.users SET membership_intro_used=TRUE WHERE id=$1", [srow.user_id]);
          }
        }

        // Keep subscription row fresh
        await upsertSubscription({
          user_id: srow?.user_id || (await one("SELECT user_id FROM public.subscriptions WHERE stripe_subscription_id=$1", [inv.subscription]))?.user_id || 0,
          stripe_subscription_id: inv.subscription,
          tier,
          status: sub.status,
          period_start: asEpochSec(sub.current_period_start),
          period_end: asEpochSec(sub.current_period_end)
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

      case "charge.refunded": {
        const charge = event.data.object;
        const invId = typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id;
        if (!invId) break;
        const inv = await stripe.invoices.retrieve(invId);
        if (!inv?.subscription) break;

        const srow = await one("SELECT * FROM public.subscriptions WHERE stripe_subscription_id=$1", [inv.subscription]);
        if (!srow) break;

        const sub = await stripe.subscriptions.retrieve(inv.subscription, { expand:["items.data.price"] });
        const priceId = sub.items.data[0].price.id;
        const tier =
          (priceId === prices.standard.full || priceId === prices.standard.intro) ? "standard" : "premium";

        const line = inv.lines?.data?.[0];
        const { start: pStart, end: pEnd } = pickPeriod({ linePeriod: line?.period, sub });

        await revokeRemainingForInvoice({
          user_id: srow.user_id,
          tier,
          invoice_id: invId,
          period_start: pStart,
          period_end: pEnd
        });
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

/* ---------------- admin: cancel+refund now ---------------- */
export function adminMembershipRoutes() {
  const r = Router();
  r.post("/subscriptions/:sid/cancel_refund_now", async (req, res) => {
    try {
      const tokenOk =
        (req.query.token && req.query.token === process.env.ADMIN_TOKEN) ||
        ((req.headers.authorization || "").trim() === `Bearer ${process.env.ADMIN_TOKEN}`);
      if (!tokenOk) return res.status(401).json({ ok:false, error:"unauthorized" });

      const sid = req.params.sid;
      const sub = await stripe.subscriptions.retrieve(sid, { expand:["latest_invoice.payment_intent","items.data.price"] });

      const tier =
        (sub.items.data[0].price.id === prices.standard.full || sub.items.data[0].price.id === prices.standard.intro) ? "standard" : "premium";
      const start = asEpochSec(sub.current_period_start);
      const end   = asEpochSec(sub.current_period_end);

      const srow = await one("SELECT * FROM public.subscriptions WHERE stripe_subscription_id=$1", [sid]);
      if (!srow) return res.status(404).json({ ok:false, error:"sub_not_found" });

      const svc = svcByTier[tier];

      const grantedRow = await one(
        `SELECT COALESCE(SUM(qty),0) AS g FROM public.credit_ledger
         WHERE user_id=$1 AND service_type=$2 AND kind='grant'
           AND valid_from IS NOT DISTINCT FROM ${start!=null ? "to_timestamp($3)" : "NULL"}
           AND valid_until IS NOT DISTINCT FROM ${end!=null ? "to_timestamp($4)" : "NULL"}`,
        start!=null && end!=null
          ? [srow.user_id, svc, start, end]
          : start!=null
            ? [srow.user_id, svc, start, null]
            : end!=null
              ? [srow.user_id, svc, null, end]
              : [srow.user_id, svc, null, null]
      );
      const granted = Number(grantedRow?.g || 0);

      const usedRow = await one(
        `SELECT COALESCE(SUM(qty),0) AS u FROM public.credit_ledger
         WHERE user_id=$1 AND service_type=$2 AND kind IN ('debit','adjust')
           AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
           AND ($4::timestamptz IS NULL OR created_at <= $4::timestamptz)`,
        [
          srow.user_id, svc,
          start != null ? new Date(start * 1000).toISOString() : null,
          end   != null ? new Date(end   * 1000).toISOString() : null
        ]
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
          [srow.user_id, svc, -granted, `admin refund invoice ${invId}`]
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
