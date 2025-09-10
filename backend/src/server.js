// backend/src/server.js
import express from "express";
import cors from "cors";
import { initDB } from "./db.js";
import baseRoutes from "./routes.js"; // availability, public config, first-time
import authRoutes from "./auth.js";
import creditsRoutes from "./credits.js";
import { membershipRoutes, adminMembershipRoutes, membershipsWebhookHandler } from "./memberships.js";
import myRoutes from "./my.js";
import { mountPayments } from "./payments.js"; // uses /api/pay/*

const app = express();
const PORT = process.env.PORT || 10000;

/* CORS */
const allow = (process.env.ALLOW_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
// If not configured, allow Vercel preview and your prod host minimally
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

/* Health */
app.get("/", (_req, res) => res.type("text/plain").send("GM API up"));
app.get("/health", (_req, res) => res.json({ ok:true }));
app.get("/api/health", (_req, res) => res.json({ ok:true }));

/* Stripe webhook for memberships (RAW BODY) */
app.post("/api/webhooks/stripe-memberships", express.raw({ type: "application/json" }), membershipsWebhookHandler);

/* JSON for normal routes (after webhook raw) */
app.use(express.json());

/* Auth + Memberships + Credits + “My” */
app.use("/api/auth", authRoutes);
app.use("/api/memberships", membershipRoutes());
app.use("/api/admin", adminMembershipRoutes());
app.use("/api/credits", creditsRoutes);
app.use("/api/my", myRoutes);

/* Public API */
app.use("/api", baseRoutes);

/* Payments (checkout, generic webhook, confirm) */
mountPayments(app);

/* 404 for unknown API */
app.use("/api", (_req, res) => res.status(404).json({ error:"not_found" }));

/* Boot */
initDB()
  .then(() => app.listen(PORT, () => console.log(`[server] listening on ${PORT}`)))
  .catch((e) => {
    console.error("[server] init failed", e);
    app.listen(PORT, () => console.log(`[server] listening on ${PORT} (DB init failed)`));
  });
