// backend/src/auth.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "./db.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
}

export async function authMiddleware(req, _res, next) {
  try {
    const h = req.headers.authorization || "";
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (!m) return next();
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = { id: payload.id, email: payload.email };
  } catch { /* ignore */ }
  next();
}

router.post("/register", async (req, res) => {
  try {
    const { email, password, name, phone, street, postcode } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok:false, error:"missing_fields" });
    const hash = await bcrypt.hash(password, 11);

    const existing = await pool.query("SELECT 1 FROM public.users WHERE lower(email)=lower($1)", [email]);
    if (existing.rowCount) return res.status(409).json({ ok:false, error:"email_in_use" });

    const r = await pool.query(
      `INSERT INTO public.users (email,password_hash,name,phone,street,postcode)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [email, hash, name||null, phone||null, street||null, postcode||null]
    );
    res.json({ ok:true, token: signToken(r.rows[0]) });
  } catch (e) {
    console.error("[auth/register]", e);
    res.status(500).json({ ok:false, error:"register_failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok:false, error:"missing_fields" });
    const r = await pool.query("SELECT * FROM public.users WHERE lower(email)=lower($1)", [email]);
    if (!r.rowCount) return res.status(401).json({ ok:false, error:"invalid_creds" });
    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash || "");
    if (!ok) return res.status(401).json({ ok:false, error:"invalid_creds" });
    res.json({ ok:true, token: signToken(u) });
  } catch (e) {
    console.error("[auth/login]", e);
    res.status(500).json({ ok:false, error:"login_failed" });
  }
});

/**
 * GET /api/auth/me
 * Returns user profile, live credits, and active subscriptions.
 */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });
    const u = await pool.query(
      "SELECT id,email,name,phone,street,postcode FROM public.users WHERE id=$1",
      [req.user.id]
    );
    if (!u.rowCount) return res.status(404).json({ ok:false, error:"not_found" });

    // live credits summary
    const c = await pool.query(
      `SELECT service_type, COALESCE(SUM(qty),0) AS bal
       FROM public.credit_ledger
       WHERE user_id=$1 AND (valid_until IS NULL OR valid_until > now())
       GROUP BY service_type`,
      [req.user.id]
    );
    const credits = { exterior: 0, full: 0 };
    for (const row of c.rows) credits[row.service_type] = Number(row.bal);

    // active/trialing/past_due subscriptions (for UI logic)
    const subs = await pool.query(
      `SELECT tier, status, EXTRACT(EPOCH FROM current_period_start)::bigint AS current_period_start,
              EXTRACT(EPOCH FROM current_period_end)::bigint   AS current_period_end
         FROM public.subscriptions
        WHERE user_id=$1
          AND status IN ('active','trialing','past_due')
        ORDER BY updated_at DESC NULLS LAST`,
      [req.user.id]
    );

    res.json({ ok:true, user: u.rows[0], credits, subscriptions: subs.rows || [] });
  } catch (e) {
    console.error("[auth/me]", e);
    res.status(500).json({ ok:false, error:"me_failed" });
  }
});

/**
 * PUT /api/auth/me
 * Update profile fields and optional password change.
 * Body: { name?, phone?, street?, postcode?, new_password? }
 * If new_password provided, it will replace the existing password (min length 8).
 */
router.put("/me", authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });

    const { name, phone, street, postcode, new_password } = req.body || {};
    const updates = [];
    const params = [];
    let idx = 1;

    if (typeof name === "string")      { updates.push(`name=$${idx++}`);      params.push(name || null); }
    if (typeof phone === "string")     { updates.push(`phone=$${idx++}`);     params.push(phone || null); }
    if (typeof street === "string")    { updates.push(`street=$${idx++}`);    params.push(street || null); }
    if (typeof postcode === "string")  { updates.push(`postcode=$${idx++}`);  params.push(postcode || null); }

    if (new_password && typeof new_password === "string") {
      if (new_password.length < 8) return res.status(400).json({ ok:false, error:"password_too_short" });
      const hash = await bcrypt.hash(new_password, 11);
      updates.push(`password_hash=$${idx++}`);
      params.push(hash);
    }

    if (updates.length) {
      params.push(req.user.id);
      const sql = `UPDATE public.users SET ${updates.join(", ")}, updated_at=now() WHERE id=$${idx}`;
      await pool.query(sql, params);
    }

    res.json({ ok:true });
  } catch (e) {
    console.error("[auth PUT /me]", e);
    res.status(500).json({ ok:false, error:"update_failed" });
  }
});

export default router;
