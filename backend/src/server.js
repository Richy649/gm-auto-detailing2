import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";

import auth from "./auth.js";
import routes from "./routes.js";
import memberships, { handleMembershipWebhook } from "./memberships.js";

const app = express();

/**
 * 1) Stripe webhooks MUST receive the raw body to validate the signature.
 *    Mount the webhook route BEFORE JSON parsing middleware.
 */
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

    // Log the event type (no sensitive data)
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

/**
 * 2) CORS + JSON for all normal API routes (mounted AFTER webhook).
 */
const allowOrigin = (process.env.ALLOW_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowOrigin.length ? allowOrigin : true,
    credentials: true,
  })
);

// Normal JSON parsing (do NOT affect the webhook above)
app.use(bodyParser.json());

/**
 * 3) API routes
 */
app.use("/api/auth", auth);
app.use("/api", routes);
app.use("/api/memberships", memberships);

/**
 * 4) Healthcheck
 */
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * 5) Start
 */
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`[server] listening on ${port}`);
});
