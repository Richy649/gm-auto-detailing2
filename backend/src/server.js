// backend/src/server.js
import express from "express";
import cors from "cors";
import { initDB } from "./db.js";

import baseRoutes from "./routes.js"; // public: /config, /availability, /first-time
import authRoutes from "./auth.js";
import creditsRoutes from "./credits.js";
import myRoutes from "./my.js";
import { membershipRoutes, adminMembershipRoutes, membershipsWebhookHandler } from "./memberships.js";
import { mountPayments } from "./payments.js"; // mounts /api/pay/* and /api/webhooks/stripe

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
    if (!origin) return cb(null, true); // same-origin, curl, SSR, etc.
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

// Stripe membership webhook MUST see the raw body before any JSON parser
app.post("/api/webhooks/memberships", express.raw({ type: "application/json" }), membershipsWebhookHandler);

// Global CORS for normal routes
app.use(cors(corsOptions));

// JSON parser for normal API routes
app.use(express.json());

// Health probe
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ============================ ROUTES ============================ */
// Auth (register/login/me/update)
app.use("/api/auth", authRoutes);

// Membership flows (subscribe, portal, etc.) — note: these are normal JSON routes
app.use("/api/memberships", membershipRoutes());

// Admin endpoints (token-guarded)
app.use("/api/admin", adminMembershipRoutes());

// Credits flow (book with credit, etc.)
app.use("/api/credits", creditsRoutes);

// “My account” endpoints (e.g., bookings list)
app.use("/api/my", myRoutes);

// Public API bundle (config, availability, first-time)
app.use("/api", baseRoutes);

// One-off payments + their Stripe webhook + confirm endpoint.
// `mountPayments` also mounts its own /api/webhooks/stripe using express.raw.
mountPayments(app);

// 404 for unknown API routes
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

/* ============================ START ============================ */
initDB()
  .catch(e => console.error("[server] init failed", e))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`[server] listening on ${PORT}`);
    });
  });
