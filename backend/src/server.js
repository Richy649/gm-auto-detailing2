// backend/src/server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { getConfig } from "./config.js";
import { getAvailability } from "./availability.js";
import { createCheckoutSession, stripeWebhook } from "./payments.js";

const app = express();
const PORT = process.env.PORT || 3001;

/* --------- CORS allowlist --------- */
const allowCSV = (process.env.CORS_ALLOW_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const allow = new Set(allowCSV);
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // health checks, curl
    if (allow.size === 0 || allow.has(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: false,
};

/* --------- Stripe webhook must use raw body BEFORE json() --------- */
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);

/* --------- Normal middleware --------- */
app.use(cors(corsOptions));
app.use(morgan("tiny"));
app.use(express.json());

/* --------- API routes --------- */
app.get("/api/config", (_req, res) => res.json(getConfig()));
app.get("/api/availability", getAvailability);
app.post("/api/pay/create-checkout-session", createCheckoutSession);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    frontend_url: process.env.FRONTEND_PUBLIC_URL || null,
    cors_allow_origins: allowCSV,
  });
});

app.get("/", (_req, res) => res.status(200).send("GM Auto Detailing API OK"));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
