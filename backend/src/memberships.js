import express from "express";
import Stripe from "stripe";
import db from "./db.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// Subscription creation endpoint
router.post("/subscribe", async (req, res) => {
  try {
    const { tier, customer } = req.body;
    if (!tier || !customer?.email) {
      return res.status(400).json({ ok: false, error: "Missing tier or customer data" });
    }

    // Ensure Stripe customer exists
    let user = await db.getUserByEmail(customer.email);
    let stripeCustomerId = user?.stripe_customer_id;

    if (!stripeCustomerId) {
      const stripeCustomer = await stripe.customers.create({
        email: customer.email,
        name: customer.name,
        phone: customer.phone,
        address: { line1: customer.street, postal_code: customer.postcode },
      });
      stripeCustomerId = stripeCustomer.id;
      if (user) {
        await db.query("UPDATE users SET stripe_customer_id=$1 WHERE id=$2", [
          stripeCustomerId,
          user.id,
        ]);
      }
    }

    // Price IDs from environment
    const priceId =
      tier === "standard"
        ? process.env.STANDARD_PRICE
        : tier === "premium"
        ? process.env.PREMIUM_PRICE
        : null;
    if (!priceId) return res.status(400).json({ ok: false, error: "Invalid tier" });

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      success_url: `${process.env.FRONTEND_PUBLIC_URL}/?sub=1&thankyou=1&flow=sub`,
      cancel_url: `${process.env.FRONTEND_PUBLIC_URL}/?sub=cancel`,
    });

    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("Subscribe failed:", err);
    res.status(500).json({ ok: false, error: "Unable to create subscription" });
  }
});

export default router;
