
// backend/src/server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { getConfig } from "./config.js";
import { getAvailability } from "./availability.js";
import { createCheckoutSession, stripeWebhook } from "./payments.js";
import { initStore } from "./store.js"; // ⬅️ add this

const app = express();
const PORT = process.env.PORT || 3001;

const ALLOW_ORIGINS = [
  "https://book.gmautodetailing.uk",
  "https://gm-auto-detailing2.vercel.app", // keep during the switch
  "http://localhost:5173"
];

const VERCEL_ANY_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOW_ORIGINS.includes(origin) || VERCEL_ANY_RE.test(origin)) return cb(null, true);
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

app.get("/api/health", async (_req, res) => {
  const { dbMode } = await import("./store.js");
  res.json({
    ok: true,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    frontend_url: process.env.FRONTEND_PUBLIC_URL || null,
    db_mode: dbMode()
  });
});

app.get("/", (_req, res) => res.status(200).send("GM Auto Detailing API OK"));

/* ✅ Ensure DB schema exists BEFORE serving requests */
await initStore();

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
