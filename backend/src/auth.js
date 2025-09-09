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

    const existing = await pool.query("SELECT * FROM public.users WHERE lower(email)=lower($1)", [email]);
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

router.get("/me", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });
    const u = await pool.query("SELECT id,email,name,phone,street,postcode FROM public.users WHERE id=$1", [req.user.id]);
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

    res.json({ ok:true, user: u.rows[0], credits });
  } catch (e) {
    console.error("[auth/me]", e);
    res.status(500).json({ ok:false, error:"me_failed" });
  }
});

export default router;
