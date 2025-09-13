// backend/src/server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

import auth from "./auth.js";
import credits from "./credits.js";
import memberships from "./memberships.js";
import pay from "./pay.js";
import config from "./config.js";

import { handleMembershipWebhook } from "./memberships.js";
import { handleOneoffWebhook } from "./pay.js";

const app = express();
const PORT = process.env.PORT || 10000;

// ========== MIDDLEWARE ==========
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = (process.env.ALLOW_ORIGIN || "").split(",");
    if (allowed.includes(origin)) cb(null, true);
    else cb(new Error("Not allowed by CORS"));
  },
  credentials: true
}));
app.use(bodyParser.json());

// ========== ROUTES ==========
app.use("/api/auth", auth);
app.use("/api/credits", credits);
app.use("/api/memberships", memberships);
app.use("/api/pay", pay);
app.use("/api/config", config);

// Stripe webhooks (raw body!)
app.post(
  "/api/stripe/memberships",
  express.raw({ type: "application/json" }),
  handleMembershipWebhook
);

app.post(
  "/api/stripe/oneoff",
  express.raw({ type: "application/json" }),
  handleOneoffWebhook
);

// Health check
app.get("/healthz", (req, res) => res.json({ ok: true }));

// ========== START ==========
app.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
});
