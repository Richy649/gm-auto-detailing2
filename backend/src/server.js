// backend/src/server.js
import express from "express";
import cors from "cors";
import { createCheckoutSession, stripeWebhook, mountPayments } from "./payments.js";

const app = express();

/* ------------------- CORS ------------------- */
const allowList = [
  "https://book.gmautodetailing.uk",
  "https://gm-auto-detailing2.vercel.app",
];
const vercelPreview = /\.vercel\.app$/i;

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowList.includes(origin) || vercelPreview.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: false,
  })
);

/* ---------------- Stripe webhook FIRST (raw) ---------------- */
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);

/* --------------- JSON body for normal API routes -------------- */
app.use(express.json());

/* ---------------- Payments endpoint ---------------- */
app.post("/api/pay/create-checkout-session", createCheckoutSession);
// (Alternatively you could do: mountPayments(app))

/* --------------- Optional: mount your existing routes --------- */
/* If you have backend/src/routes.js that defines /api/availability, etc. */
(async function mountOptionalRoutes() {
  try {
    const mod = await import("./routes.js"); // must exist to mount
    const router =
      mod.default ||
      mod.router ||
      mod.routes ||
      (typeof mod.mount === "function" ? mod.mount(express.Router()) : null);

    if (router) {
      app.use("/api", router);
      console.log("[server] Mounted routes.js under /api");
    }
  } catch (err) {
    console.warn("[server] routes.js not found or failed to load. Fallback endpoints only.", err?.message || "");
  }
})();

/* ----------------- Fallback /api/config ----------------- */
/* If your routes.js provides /config already, this will be shadowed (that’s fine). */
app.get("/api/config", (_req, res) => {
  res.json({
    services: {
      exterior: { key: "exterior", name: "Exterior Detail", price: 40, duration_min: 75 },
      full: { key: "full", name: "Full Detail", price: 60, duration_min: 120 },
      standard_membership: { key: "standard_membership", name: "Standard Membership (2 Exterior)", price: 70 },
      premium_membership: { key: "premium_membership", name: "Premium Membership (2 Full)", price: 100 },
    },
    addons: {
      wax: { key: "wax", name: "Full Body Wax", price: 10 },
      polish: { key: "polish", name: "Hand Polish", price: 22.5 },
    },
  });
});

/* ------------------- Health & root ------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api", (_req, res) => res.json({ ok: true, name: "GM API", version: 1 }));

/* ------------------- Start server ------------------- */
const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log("API listening on", port);
  if (!process.env.PUBLIC_APP_ORIGIN) {
    console.warn(
      "[server] PUBLIC_APP_ORIGIN not set. Set it to your frontend origin, e.g. https://book.gmautodetailing.uk"
    );
  }
});
