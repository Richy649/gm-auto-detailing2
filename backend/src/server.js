// backend/src/server.js
import express from "express";
import cors from "cors";

import routes from "./routes.js";
import { initDB, listRecentBookings } from "./db.js";
import { mountPayments } from "./payments.js";

const app = express();
const PORT = process.env.PORT || 10000;

/* ---------- CORS ---------- */
/* Allow your Vercel site and/or Squarespace iframe origin(s).
   Set ALLOW_ORIGIN in Render like:
   https://book.gmautodetailing.uk,https://gm-auto-detailing2.vercel.app
   You can use "*" while debugging. */
const allow = (process.env.ALLOW_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allow.includes("*") ? true : (origin, cb) => {
    // allow no origin (e.g., curl) and any listed
    if (!origin || allow.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  optionsSuccessStatus: 204
}));

/* ---------- Simple root + health (for Render) ---------- */
app.get("/", (_req, res) => res.type("text/plain").send("GM API up"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ---------- Stripe: mount webhook & checkout BEFORE express.json() ----------
   (Stripe's webhook needs raw body and must not be affected by global JSON parsing) */
mountPayments(app);

/* ---------- JSON parser for the rest of the API ---------- */
app.use(express.json());

/* ---------- Main API (config, availability, first-time, etc.) ---------- */
app.use("/api", routes);

/* ---------- Admin (optional) ----------
   GET /api/admin/recent?token=YOUR_ADMIN_TOKEN[&limit=10]
   Returns last N bookings for quick verification.
   Set ADMIN_TOKEN in Render to any random string to enable. */
if (process.env.ADMIN_TOKEN) {
  app.get("/api/admin/recent", async (req, res) => {
    try {
      const token = req.query.token || "";
      if (!token || token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const lim = Math.max(1, Math.min(100, Number(req.query.limit) || 10));
      const rows = await listRecentBookings(lim);
      res.json({ rows });
    } catch (e) {
      console.warn("[admin/recent] error", e?.message || e);
      res.status(500).json({ error: "admin_failed" });
    }
  });
}

/* ---------- 404 for unknown /api routes ---------- */
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

/* ---------- Boot ---------- */
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] listening on ${PORT}`));
  })
  .catch((e) => {
    console.error("[server] init failed", e);
    // still start server so health & webhook endpoints work
    app.listen(PORT, () => console.log(`[server] listening on ${PORT} (DB init failed)`));
  });
