// backend/src/server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { pool } from "./db.js";

// Routers / modules
import auth from "./auth.js";
import availability from "./availability.js";
import my from "./my.js";
import credits from "./credits.js";
import memberships, { handleMembershipWebhook } from "./memberships.js";
import { mountPayments } from "./payments.js";

/* ============================ ENV & CORS ============================ */
const PORT = Number(process.env.PORT || 10000);

// Build allowed origins from env (comma-separated)
function parseList(v) {
  return (v || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}
const allowFrom = new Set([
  ...parseList(process.env.ALLOW_ORIGIN),
  ...parseList(process.env.FRONTEND_ORIGIN),
  process.env.FRONTEND_PUBLIC_URL,
  process.env.PUBLIC_APP_ORIGIN,
  "https://book.gmautodetailing.uk",
  "https://gm-auto-detailing2.vercel.app",
].filter(Boolean).map(s => {
  try { return new URL(s).origin; } catch { return s; }
}));

const corsOptions = {
  origin: (origin, cb) => {
    // Allow same-origin or no-origin (curl, mobile webviews)
    if (!origin) return cb(null, true);
    try {
      const o = new URL(origin).origin;
      if (allowFrom.has(o)) return cb(null, true);
    } catch {}
    return cb(null, false);
  },
  credentials: true,
};

/* ============================ APP SETUP ============================ */
const app = express();

// Access logs (concise)
app.use(morgan("tiny"));

// IMPORTANT: register Stripe webhooks with RAW BODY BEFORE any json middleware.
// - /api/webhooks/stripe is mounted inside mountPayments(app) (uses express.raw)
// - /api/webhooks/memberships mounted here
app.post("/api/webhooks/memberships", express.raw({ type: "application/json" }), handleMembershipWebhook);

// Now global CORS
app.use(cors(corsOptions));

// For all other JSON APIs
app.use(express.json());

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ============================ ROUTES ============================ */
// Auth (register/login/me, etc.)
app.use("/api/auth", auth);

// Availability calendar (GET /availability?service_key=...&month=YYYY-MM)
app.use("/api", availability);

// “My account” endpoints (e.g., GET /my/bookings)
app.use("/api/my", my);

// Credits flow (e.g., POST /credits/book-with-credit)
app.use("/api/credits", credits);

// Memberships (subscribe, portal, etc.)
app.use("/api/memberships", memberships);

// One-off payments + one-off Stripe webhook + confirm endpoint
// (mountPayments also mounts: POST /api/pay/create-checkout-session, POST /api/pay/confirm,
// and POST /api/webhooks/stripe with express.raw)
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
