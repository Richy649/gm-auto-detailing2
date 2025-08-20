// backend/src/server.js
import express from "express";
import cors from "cors";
import { createCheckoutSession, stripeWebhook } from "./payments.js";
import apiRoutes from "./routes.js";

const app = express();

/* ------------ CORS (allow your frontends) ------------ */
const allowList = [
  "https://book.gmautodetailing.uk",
  "https://gm-auto-detailing2.vercel.app",
];
const vercelPreview = /\.vercel\.app$/i;

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowList.includes(origin) || vercelPreview.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: false,
  })
);

/* -------- Stripe webhook FIRST (RAW body) -------- */
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);

/* -------- Normal JSON body for the rest -------- */
app.use(express.json());

/* -------- Payments endpoint -------- */
app.post("/api/pay/create-checkout-session", createCheckoutSession);

/* -------- Your API routes (/api/availability, etc.) -------- */
app.use("/api", apiRoutes);

/* -------- Fallback /api/config -------- */
app.get("/api/config", (_req, res) => {
  res.json({
    services: {
      exterior: { key: "exterior", name: "Exterior Detail", price: 40, duration_min: 75 },
      full: { key: "full", name: "Full Detail", price: 60, duration_min: 120 },
      standard_membership: { key: "standard_membership", name: "Standard Membership (2 Exterior)", price: 70, duration_min: 75 },
      premium_membership: { key: "premium_membership", name: "Premium Membership (2 Full)", price: 100, duration_min: 120 },
    },
    addons: {
      wax: { key: "wax", name: "Full Body Wax", price: 10 },
      polish: { key: "polish", name: "Hand Polish", price: 22.5 },
    },
  });
});

/* -------- Health -------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------- Start -------- */
const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log("API listening on", port);
  if (!process.env.PUBLIC_APP_ORIGIN) {
    console.warn("[server] Set PUBLIC_APP_ORIGIN to your frontend origin, e.g. https://book.gmautodetailing.uk");
  }
});
