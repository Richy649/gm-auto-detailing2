import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";
import routes from "./routes.js";
import memberships from "./memberships.js";
import { handleMembershipWebhook } from "./credits.js";

const app = express();

// CORS
const allowOrigin = process.env.ALLOW_ORIGIN?.split(",") || [];
app.use(
  cors({
    origin: allowOrigin,
    credentials: true,
  })
);

// Normal JSON parsing (non-webhooks)
app.use(bodyParser.json());

// Routes
app.use("/api", routes);
app.use("/api/memberships", memberships);

// Stripe webhook (raw body required)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
app.post(
  "/webhooks/memberships",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET_MEMBERSHIPS
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle event
    handleMembershipWebhook(event)
      .then(() => res.json({ received: true }))
      .catch((err) => {
        console.error("Webhook handling failed:", err);
        res.status(500).send("Webhook handling failed");
      });
  }
);

// Healthcheck
app.get("/health", (req, res) => res.json({ ok: true }));

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
