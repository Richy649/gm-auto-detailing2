// backend/src/server.js
import express from "express";
import cors from "cors";
import { initDB } from "./db.js";
import routes from "./routes.js";                 // your existing /api (config, availability, etc.)
import authRoutes, { authMiddleware } from "./auth.js";
import creditsRoutes from "./credits.js";
import { membershipRoutes, adminMembershipRoutes, membershipsWebhookHandler } from "./memberships.js";

const app = express();
const PORT = process.env.PORT || 10000;

/* ---------- CORS ---------- */
const allow = (process.env.ALLOW_ORIGIN || "*")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allow.includes("*") ? true : (origin, cb) => (!origin || allow.includes(origin) ? cb(null, true) : cb(new Error("CORS blocked: " + origin))),
  optionsSuccessStatus: 204
}));

/* ---------- Health ---------- */
app.get("/", (_req, res) => res.type("text/plain").send("GM API up"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ---------- Stripe memberships webhook (RAW BODY) ---------- */
app.post("/api/webhooks/stripe-memberships", express.raw({ type: "application/json" }), membershipsWebhookHandler);

/* ---------- JSON for everything else ---------- */
app.use(express.json());

/* ---------- Auth + Membership + Credits ---------- */
app.use("/api/auth", authRoutes);
app.use("/api/memberships", membershipRoutes());
app.use("/api/admin", adminMembershipRoutes());   // protected by ADMIN_TOKEN query param inside

app.use("/api/credits", creditsRoutes);           // book-with-credit

/* ---------- Your existing API ---------- */
app.use("/api", routes);

/* ---------- 404 for unknown api ---------- */
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

/* ---------- Boot ---------- */
initDB()
  .then(() => app.listen(PORT, () => console.log(`[server] listening on ${PORT}`)))
  .catch((e) => {
    console.error("[server] init failed", e);
    app.listen(PORT, () => console.log(`[server] listening on ${PORT} (DB init failed)`));
  });
