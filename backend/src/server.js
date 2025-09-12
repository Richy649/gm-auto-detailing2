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

/* -------------------------- Stripe Webhooks -------------------------- */
/** Memberships webhook (raw) — mount BEFORE json parser */
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

/** One-off payments webhook (raw) — mount BEFORE json parser */
mountPayments(app);

/* ------------------------------ CORS/JSON ----------------------------- */
const allowOrigin = (process.env.ALLOW_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowOrigin.length ? allowOrigin : true,
    credentials: true,
  })
);

// JSON body parser AFTER both webhook mounts
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
