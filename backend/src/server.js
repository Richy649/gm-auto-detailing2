// backend/src/server.js
import express from "express";
import cors from "cors";
import { initDB } from "./db.js";
import baseRoutes from "./routes.js"; // availability, public config, first-time
import authRoutes from "./auth.js";
import creditsRoutes from "./credits.js";
import { membershipRoutes, adminMembershipRoutes, membershipsWebhookHandler } from "./memberships.js";
import myRoutes from "./my.js";
import { mountPayments } from "./payments.js"; // /api/pay/* (includes its own /api/webhooks/stripe)

// Boot DB before starting server (non-fatal if it fails; app still starts)
initDB().catch((e) => {
  console.error("[server] init failed", e);
});

const app = express();
const PORT = process.env.PORT || 10000;

/* ---------- CORS ---------- */
const allow = (process.env.ALLOW_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
const vercelPreview = /\.vercel\.app$/i;
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allow.includes("*")) return cb(null, true);
    if (allow.includes(origin)) return cb(null, true);
    if (vercelPreview.test(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  credentials: true
}));

/* ---------- Health ---------- */
app.get("/", (_req, res) => res.type("text/plain").send("GM API up"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/**
 * IMPORTANT: Stripe webhooks MUST receive the RAW body.
 * Therefore:
 *   1) mount the memberships webhook BEFORE express.json()
 *   2) mount payments (which registers /api/webhooks/stripe with RAW) BEFORE express.json() OR within mountPayments
 */
app.post("/api/webhooks/stripe-memberships", express.raw({ type: "application/json" }), membershipsWebhookHandler);

/**
 * Payments module registers:
 *   - POST /api/webhooks/stripe (RAW body)
 *   - POST /api/pay/create-checkout-session
 *   - POST /api/pay/confirm
 */
mountPayments(app);

/* ---------- JSON for normal routes (after RAW webhook mounts) ---------- */
app.use(express.json());

/* ---------- Auth + Memberships + Credits + “My” ---------- */
app.use("/api/auth", authRoutes);
app.use("/api/memberships", membershipRoutes());
app.use("/api/admin", adminMembershipRoutes());
app.use("/api/credits", creditsRoutes);
app.use("/api/my", myRoutes);

/* ---------- Public API ---------- */
app.use("/api", baseRoutes);

/* ---------- 404 for unknown API ---------- */
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

/* ---------- Listen ---------- */
app.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
});
