// backend/src/server.js
import express from "express";
import cors from "cors";
import { initDB } from "./db.js";
import routes from "./routes.js"; // config, availability, first-time
import authRoutes from "./auth.js";
import creditsRoutes from "./credits.js";
import { membershipRoutes, adminMembershipRoutes, membershipsWebhookHandler } from "./memberships.js";
import { mountPayments } from "./payments.js"; // creates /api/webhooks/stripe with RAW body

const app = express();
const PORT = process.env.PORT || 10000;

/* ---------- CORS ---------- */
function normOrigin(s) { return String(s || "").trim().replace(/\/+$/, ""); }
const vercelPreview = /\.vercel\.app$/i;

const defaultAllow = [
  "https://book.gmautodetailing.uk",
  "https://gm-auto-detailing2.vercel.app",
  "http://localhost:5173",
];

const envAllow = (process.env.ALLOW_ORIGIN || "")
  .split(",")
  .map(normOrigin)
  .filter(Boolean);

const allowSet = new Set((envAllow.length ? envAllow : defaultAllow).map(normOrigin));

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // non-browser or same-origin
      const o = normOrigin(origin);
      if (allowSet.has(o) || vercelPreview.test(o)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    optionsSuccessStatus: 204,
  })
);

/* ---------- Health ---------- */
app.get("/", (_req, res) => res.type("text/plain").send("GM API up"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ---------- Stripe webhooks that require RAW body (MUST come before express.json) ---------- */
app.post(
  "/api/webhooks/stripe-memberships",
  express.raw({ type: "application/json" }),
  membershipsWebhookHandler
);

// The payments module registers /api/webhooks/stripe (RAW) and other pay routes.
mountPayments(app);

/* ---------- Normal JSON for the rest ---------- */
app.use(express.json());

/* ---------- Auth + Memberships + Credits ---------- */
app.use("/api/auth", authRoutes);
app.use("/api/memberships", membershipRoutes());
app.use("/api/admin", adminMembershipRoutes());
app.use("/api/credits", creditsRoutes);

/* ---------- Existing API (config, availability, first-time) ---------- */
app.use("/api", routes);

/* ---------- 404 for unknown API ---------- */
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

/* ---------- Boot ---------- */
initDB()
  .then(() => app.listen(PORT, () => console.log(`[server] listening on ${PORT}`)))
  .catch((e) => {
    console.error("[server] init failed", e);
    app.listen(PORT, () => console.log(`[server] listening on ${PORT} (DB init failed)`));
  });
