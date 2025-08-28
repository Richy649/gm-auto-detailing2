// backend/src/server.js
import express from "express";
import cors from "cors";
import { createCheckoutSession, stripeWebhook } from "./payments.js";
import apiRoutes from "./routes.js";
import { initDB } from "./db.js";

await initDB();
const app = express();

/* CORS */
const allowList = [
  "https://book.gmautodetailing.uk",
  "https://gm-auto-detailing2.vercel.app",
];
const vercelPreview = /\.vercel\.app$/i;
app.use(cors({
  origin(origin, cb){
    if (!origin) return cb(null, true);
    if (allowList.includes(origin) || vercelPreview.test(origin)) return cb(null, true);
    return cb(null, false);
  }
}));

/* Stripe webhook (RAW) */
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);

/* Normal JSON */
app.use(express.json());

/* Payments */
app.post("/api/pay/create-checkout-session", createCheckoutSession);

/* API */
app.use("/api", apiRoutes);

/* Config exposes discount so frontend can show strikethrough */
app.get("/api/config", (_req,res)=>{
  res.json({
    services: {
      exterior: { key:"exterior", name:"Exterior Detail", price:40, duration_min:75 },
      full: { key:"full", name:"Full Detail", price:60, duration_min:120 },
      standard_membership: { key:"standard_membership", name:"Standard Membership (2 Exterior)", price:70, duration_min:75 },
      premium_membership: { key:"premium_membership", name:"Premium Membership (2 Full)", price:100, duration_min:120 },
    },
    addons: { wax:{key:"wax", name:"Full Body Wax", price:10}, polish:{key:"polish", name:"Hand Polish", price:22.5} },
    discount_gbp: Number(process.env.DISCOUNT_GBP || 0)
  });
});

/* Health */
app.get("/health", (_req,res)=> res.json({ ok:true }));

const port = process.env.PORT || 3001;
app.listen(port, ()=> {
  console.log("API listening on", port);
});
