// backend/server.js (ESM)
import express from "express";
import cors from "cors";
import { createCheckoutSession, stripeWebhook } from "./payments.js";

const app = express();

/* CORS (allow all while testing; tighten later) */
app.use(cors());

/* Stripe webhook MUST get the raw body (before express.json) */
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, _res, next) => { req.rawBody = req.body; next(); },
  stripeWebhook
);

/* All other routes use JSON */
app.use(express.json());

/* Config for frontend */
app.get("/api/config", (_req, res) => {
  res.json({
    services: {
      exterior: { name: "Exterior Detail", duration: 75, price: 40 },
      full: { name: "Full Detail", duration: 120, price: 60 },
      standard_membership: { name: "Standard Membership (2 Exterior visits)", duration: 75, visits: 2, visitService: "exterior", price: 70 },
      premium_membership: { name: "Premium Membership (2 Full visits)", duration: 120, visits: 2, visitService: "full", price: 100 },
    },
    addons: { wax: { name: "Full Body Wax", price: 15 }, polish: { name: "Hand Polish", price: 15 } },
  });
});

/* Stripe checkout session */
app.post("/api/pay/create-checkout-session", createCheckoutSession);

/* Health */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`[api] listening on ${PORT}`));
