// backend/src/server.js
import express from "express";
import cors from "cors";
import { pool } from "./db.js";

import auth from "./auth.js";
import availability from "./availability.js";
import my from "./my.js";
import credits from "./credits.js";
import memberships, { handleMembershipWebhook } from "./memberships.js";
import { mountPayments } from "./payments.js";

/* ============================ ENV & CORS ============================ */
const PORT = Number(process.env.PORT || 10000);

function parseList(v) {
  return (v || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

const allowedOrigins = new Set(
  [
    ...parseList(process.env.ALLOW_ORIGIN),
    ...parseList(process.env.FRONTEND_ORIGIN),
    process.env.FRONTEND_PUBLIC_URL,
    process.env.PUBLIC_APP_ORIGIN,
    "https://book.gmautodetailing.uk",
    "https://gm-auto-detailing2.vercel.app",
  ]
  .filter(Boolean)
  .map(s => {
    try { return new URL(s).origin; } catch { return s; }
  })
);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin, curl, server-side, etc.
    try {
      const o = new URL(origin).origin;
      if (allowedOrigins.has(o)) return cb(null, true);
    } catch {}
    return cb(null, false);
  },
  credentials: true,
};

/* ============================ APP SETUP ============================ */
const app = express();

/**
 * IMPORTANT: Stripe webhooks must see the raw body.
 * Mount membership webhook BEFORE any express.json() middleware.
 */
app.post(
  "/api/webhooks/memberships",
  express.raw({ type: "application/json" }),
  handleMembershipWebhook
);

// Global CORS
app.use(cors(corsOptions));

// JSON parser for normal API routes
app.use(express.json());

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ============================ ROUTES ============================ */
// Auth (register/login/me)
app.use("/api/auth", auth);

// Availability (GET /api/availability?service_key=...&month=YYYY-MM)
app.use("/api", availability);

// Account endpoints (e.g., GET /api/my/bookings)
app.use("/api/my", my);

// Credits flow (e.g., POST /api/credits/book-with-credit)
app.use("/api/credits", credits);

// Memberships (subscribe, portal, etc.)
app.use("/api/memberships", memberships);

// One-off payments + their Stripe webhook + confirm endpoint
// mountPayments() internally mounts:
//   POST /api/pay/create-checkout-session
//   POST /api/pay/confirm
//   POST /api/webhooks/stripe  (with express.raw)
mountPayments(app);

/* ============================ START ============================ */
async function start() {
  try {
    await pool.query("SELECT 1");
    console.log("[db] schema ensured");
  } catch (e) {
    console.error("[db] connection failed:", e?.message || e);
  }

  app.listen(PORT, () => {
    console.log(`[server] listening on ${PORT}`);
  });
}

start();
