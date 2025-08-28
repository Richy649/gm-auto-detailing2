// backend/src/server.js
import express from "express";
import cors from "cors";
import routes from "./routes.js";
import { initDB } from "./db.js";
import { mountPayments } from "./payments.js";

const app = express();
const PORT = process.env.PORT || 10000;

/* CORS: allow all (or set ALLOW_ORIGIN env if you want to restrict) */
const allow = process.env.ALLOW_ORIGIN || "*";
app.use(cors({
  origin: allow === "*" ? true : allow.split(",").map(s=>s.trim()),
}));

/* Health */
app.get("/api/health", (req, res) => res.json({ ok: true }));

/* Payments (note: /api/pay/create-checkout-session uses express.json in payments.js; webhook uses express.raw) */
mountPayments(app);

/* JSON body for the rest of API */
app.use(express.json());

/* Main API routes */
app.use("/api", routes);

/* 404 for other /api paths */
app.use("/api", (req, res) => res.status(404).json({ error: "not_found" }));

/* Boot */
initDB()
  .then(() => app.listen(PORT, () => console.log(`[server] listening on ${PORT}`)))
  .catch((e) => {
    console.error("[server] init failed", e);
    app.listen(PORT, () => console.log(`[server] listening on ${PORT} (DB init failed)`));
  });
