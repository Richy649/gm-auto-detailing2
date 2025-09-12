// backend/src/server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";

import auth from "./auth.js";
import routes from "./routes.js";
import memberships, { handleMembershipWebhook } from "./memberships.js";
import credits from "./credits.js";
import { mountPayments } from "./payments.js";

const app = express();

/* ------------------------------ CORS FIRST ------------------------------ */
/** Apply CORS before any routes so preflights for /api/pay/* succeed */
const allowOrigin = (process.env.ALLOW_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsConfig = {
  origin: allowOrigin.length ? allowOrigin : true,
  credentials: true,
};
app.use(cors(corsConfig));
// (Optional but helpful for some hosts)
app.options("*", cors(corsConfig));

/* -------------------------- Stripe Webhooks -------------------------- */
/** Memberships webhook (raw) — must be mounted before json parser */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
app.post(
  "/webhooks/memberships",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET_MEMBERSHIPS
      );
    } catch (err) {
      console.error("[webhooks/memberships] signature verification failed:", err?.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      console.log(`[webhooks/memberships] received: ${event.type}`);
      await handleMembershipWebhook(event);
      return res.json({ received: true });
    } catch (err) {
      console.error("[webhooks/memberships] handler failed:", err);
      return res.status(500).send("Webhook handling failed");
    }
  }
);

/** One-off payments webhook + routes (raw inside) — mount before json parser */
mountPayments(app);

/* ------------------------------ JSON AFTER ----------------------------- */
/** JSON body parser MUST come after raw webhooks to avoid consuming the body */
app.use(bodyParser.json());

/* --------------------------------- API -------------------------------- */
app.use("/api/auth", auth);
app.use("/api", routes);
app.use("/api/memberships", memberships);
app.use("/api/credits", credits);

/* ------------------------------ Healthcheck --------------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------------------- Start ------------------------------- */
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`[server] listening on ${port}`);
});
