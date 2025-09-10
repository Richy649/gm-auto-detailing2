// backend/src/server.js
import express from "express";
import cors from "cors";
import { initDB } from "./db.js";
import apiRoutes from "./routes.js";
import authRoutes from "./auth.js";
import creditsRoutes from "./credits.js";
import { membershipRoutes, adminMembershipRoutes, membershipsWebhookHandler } from "./memberships.js";
import { mountPayments } from "./payments.js";

const app = express();
const PORT = process.env.PORT || 10000;

/* CORS: use a single, explicit allowlist via ALLOW_ORIGIN (comma-separated) or fallback to Vercel + Squarespace subdomains */
const allow = (process.env.ALLOW_ORIGIN || "https://book.gmautodetailing.uk,https://gm-auto-detailing2.vercel.app").split(",").map(s => s.trim()).filter(Boolean);
const vercelPreview = /\.vercel\.app$/i;

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allow.includes(origin) || vercelPreview.test(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  optionsSuccessStatus: 204
}));

/* Health */
app.get("/", (_req, res) => res.type("text/plain").send("GM API up"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* Webhooks that require RAW body go first */
app.post("/api/webhooks/stripe-memberships", express.raw({ type: "application/json" }), membershipsWebhookHandler);

/* Normal JSON after raw webhooks */
app.use(express.json());

/* Payments (one-off) */
mountPayments(app);

/* Auth + Memberships + Credits */
app.use("/api/auth", authRoutes);
app.use("/api/memberships", membershipRoutes());
app.use("/api/admin", adminMembershipRoutes());
app.use("/api/credits", creditsRoutes);

/* Public API (config, availability, first-time) */
app.use("/api", apiRoutes);

/* 404 for unknown API */
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

/* Boot */
initDB()
  .then(() => app.listen(PORT, () => console.log(`[server] listening on ${PORT}`)))
  .catch((e) => {
    console.error("[server] init failed", e);
    app.listen(PORT, () => console.log(`[server] listening on ${PORT} (DB init failed)`));
  });
