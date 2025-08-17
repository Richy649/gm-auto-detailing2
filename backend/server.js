// backend/src/server.js
import express from "express";
import cors from "cors";
import { createCheckoutSession, stripeWebhook } from "./payments.js";

const app = express();

/* ---------- CORS: allow your Vercel domain ---------- */
const ALLOW_ORIGIN = process.env.FRONTEND_PUBLIC_URL || "*";
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOW_ORIGIN === "*" || origin === ALLOW_ORIGIN) return cb(null, true);
      return cb(null, false);
    },
    credentials: false,
  })
);

/* ---------- Stripe webhook needs RAW body (must be BEFORE express.json) ---------- */
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, _res, next) => {
    // Save raw buffer for signature verification inside payments.js
    req.rawBody = req.body;
    next();
  },
  stripeWebhook
);

/* ---------- All other routes use JSON parser ---------- */
app.use(express.json());

/* ---------- Config endpoint used by your frontend ---------- */
app.get("/api/config", (_req, res) => {
  res.json({
    services: {
      exterior: { name: "Exterior Detail", duration: 75, price: 40 },
      full: { name: "Full Detail", duration: 120, price: 60 },
      standard_membership: {
        name: "Standard Membership (2 Exterior visits)",
        duration: 75,
        visits: 2,
        visitService: "exterior",
        price: 70,
      },
      premium_membership: {
        name: "Premium Membership (2 Full visits)",
        duration: 120,
        visits: 2,
        visitService: "full",
        price: 100,
      },
    },
    addons: {
      wax: { name: "Full Body Wax", price: 15 },
      polish: { name: "Hand Polish", price: 15 },
    },
  });
});

/* ---------- Payments: create Stripe Checkout session ---------- */
app.post("/api/pay/create-checkout-session", createCheckoutSession);

/* ---------- Healthcheck ---------- */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ---------- (Optional) Add YOUR other API routes here ----------
   Example:
   import router from "./routes.js";
   app.use("/api", router);
------------------------------------------------------------------ */

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`[api] listening on ${PORT}`));
