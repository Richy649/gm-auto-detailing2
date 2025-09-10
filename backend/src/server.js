// backend/src/server.js
import express from "express";
import cors from "cors";
import { initDB } from "./db.js";
import routes from "./routes.js"; // config, availability, first-time
import authRoutes from "./auth.js";
import creditsRoutes from "./credits.js";
import { membershipRoutes, adminMembershipRoutes, membershipsWebhookHandler } from "./memberships.js";
import { mountPayments } from "./payments.js";
import { mountMigrationRoute } from "./migrations-temp.js";

const app = express();
const PORT = process.env.PORT || 10000;

/* CORS: prefer env ALLOW_ORIGIN for flexibility, else allow Vercel + Squarespace embed host */
const envAllow = (process.env.ALLOW_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
const defaultAllow = [
  "https://gm-auto-detailing2.vercel.app",
  "https://book.gmautodetailing.uk"
];
const allowList = envAllow.length ? envAllow : defaultAllow;
const vercelPreview = /\.vercel\.app$/i;

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowList.includes(origin) || vercelPreview.test(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  }
}));

/* Health */
app.get("/", (_req, res) => res.type("text/plain").send("GM API up"));
app.get("/health", (_req, res) => res.json({ ok:true }));
app.get("/api/health", (_req, res) => res.json({ ok:true }));

/* Stripe webhooks that require RAW body — mount BEFORE express.json() */
app.post("/api/webhooks/stripe-memberships", express.raw({ type: "application/json" }), membershipsWebhookHandler);
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), (req, res, next) => next()); // payments mounts its own handler inside

/* Normal JSON after raw webhook routes */
app.use(express.json());

/* TEMP migration endpoint (one-off to create users/subscriptions/ledger tables and indexes) */
mountMigrationRoute(app);

/* Auth + Memberships + Credits */
app.use("/api/auth", authRoutes);
app.use("/api/memberships", membershipRoutes());
app.use("/api/admin", adminMembershipRoutes());
app.use("/api/credits", creditsRoutes);

/* Payments (checkout session, confirm, and its webhook handler) */
mountPayments(app);

/* Your existing API (config/availability/first-time) */
app.use("/api", routes);

/* 404 for unknown API */
app.use("/api", (_req, res) => res.status(404).json({ error:"not_found" }));

/* Boot */
initDB()
  .then(() => app.listen(PORT, () => console.log(`[server] listening on ${PORT}`)))
  .catch((e) => {
    console.error("[server] init failed", e);
    app.listen(PORT, () => console.log(`[server] listening on ${PORT} (DB init failed)`));
  });
