import { Router } from "express";
import { hasExistingCustomer } from "./db.js";

const router = Router();

/* ---- availability code you already have (unchanged) ---- */
// ... keep your existing availability route here ...

/* First-time check by identity: email OR phone OR street (name/postcode ignored) */
router.get("/first-time", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    const phone = String(req.query.phone || "").trim();
    const street = String(req.query.street || "").trim().toLowerCase();

    if (!email && !phone && !street) return res.json({ first_time: true });
    const seen = await hasExistingCustomer({ email, phone, street });
    return res.json({ first_time: !seen });
  } catch (e) {
    console.warn("[/api/first-time] fallback true", e?.message);
    return res.json({ first_time: true });
  }
});

export default router;
