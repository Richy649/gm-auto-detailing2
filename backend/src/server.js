// backend/src/server.js
import express from "express";
import cors from "cors";
import { pool } from "./db.js";

import baseRoutes from "./routes.js";                // /api (config, availability, first-time)
import auth from "./auth.js";                        // /api/auth
import credits from "./credits.js";                  // /api/credits
import my from "./my.js";                            // /api/my
import memberships, { handleMembershipWebhook } from "./memberships.js"; // /api/memberships + webhook
import { mountPaymentsWebhook, mountPaymentsRoutes } from "./payments.js"; // one-off webhook & routes

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
    if (!origin) return cb(null, true); // same-origin, curl, SSR, health checks
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
 * STRIPE WEBHOOKS MUST SEE RAW BODY (NO express.json BEFORE THESE).
 * Mount both webhooks first.
 */
app.post("/api/webhooks/memberships", express.raw({ type: "application/json" }), handleMembershipWebhook);
mountPaymentsWebhook(app); // mounts: POST /api/webhooks/stripe with express.raw

// Now mount global CORS and the normal JSON parser.
app.use(cors(corsOptions));
app.use(express.json());

// Health probe
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ============================ ROUTES ============================ */
// Auth (register, login, me, update)
app.use("/api/auth", auth);

// Credits flow (book with credit, etc.)
app.use("/api/credits", credits);

// “My account” endpoints (bookings list, etc.)
app.use("/api/my", my);

// Membership flows (subscribe, portal, etc.)
app.use("/api/memberships", memberships);

// Public routes bundle: /api/config, /api/availability, /api/first-time
app.use("/api", baseRoutes);

// One-off payments (checkout, confirm) — normal JSON routes
mountPaymentsRoutes(app);

// Fallback for unknown API routes
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

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
