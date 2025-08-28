import express from "express";
import cors from "cors";
import routes from "./routes.js";
import { initDB } from "./db.js";
import { mountPayments } from "./payments.js";

const app = express();
const PORT = process.env.PORT || 10000;

/* CORS: allow your Vercel app (or * while debugging) */
const allow = process.env.ALLOW_ORIGIN || "*";
app.use(cors({
  origin: allow === "*" ? true : allow.split(",").map(s => s.trim()),
}));

/* Simple root + health so Render never returns 404 at / */
app.get("/", (_req, res) => res.type("text/plain").send("GM API up"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* Mount Stripe endpoints (webhook needs raw, create-checkout uses json inside payments.js) */
mountPayments(app);

/* JSON parser for the rest of API */
app.use(express.json());

/* Main API under /api */
app.use("/api", routes);

/* 404 handler JUST for /api after routes are mounted */
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

/* Boot */
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] listening on ${PORT}`));
  })
  .catch((e) => {
    console.error("[server] init failed", e);
    app.listen(PORT, () => console.log(`[server] listening on ${PORT} (DB init failed)`));
  });
