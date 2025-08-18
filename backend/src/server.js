// backend/src/server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { getConfig } from "./config.js";
import { getAvailability } from "./availability.js";
import { createCheckoutSession, stripeWebhook } from "./payments.js";

const app = express();
const PORT = process.env.PORT || 3001;

/* ===== CORS: allow prod + any Vercel preview for this project + localhost ===== */
const ALLOW_ORIGINS = [
  "https://gm-auto-detailing2.vercel.app",
  "http://localhost:5173"
];
// matches any preview like gm-auto-detailing2-xxxx.vercel.app
const VERCEL_PREVIEW_RE = /^https:\/\/gm-auto-detailing2-[a-z0-9-]+\.vercel\.app$/i;

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // health/curl
    if (ALLOW_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: false,
};

/* Stripe webhook must be raw BEFORE json() */
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);

/* Normal middleware */
app.use(cors(corsOptions));
app.use(morgan("tiny"));
app.use(express.json());

/* Routes */
app.get("/api/config", (_req, res) => res.json(getConfig()));
app.get("/api/availability", getAvailability);
app.post("/api/pay/create-checkout-session", createCheckoutSession);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    frontend_url: process.env.FRONTEND_PUBLIC_URL || null
  });
});

app.get("/", (_req, res) => res.status(200).send("GM Auto Detailing API OK"));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
