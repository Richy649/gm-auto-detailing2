// backend/src/auth.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
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
    const { email, password, name, phone, street, postcode, has_tap } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok:false, error:"missing_fields" });
    if (!has_tap) return res.status(400).json({ ok:false, error:"tap_required" });

    const hash = await bcrypt.hash(password, 11);
    const existing = await pool.query("SELECT 1 FROM public.users WHERE lower(email)=lower($1)", [email]);
    if (existing.rowCount) return res.status(409).json({ ok:false, error:"email_in_use" });

    const r = await pool.query(
      `INSERT INTO public.users (email,password_hash,name,phone,street,postcode,has_tap)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [email, hash, name||null, phone||null, street||null, postcode||null, !!has_tap]
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

    res.json({ ok:true, user: u.rows[0], credits });
  } catch (e) {
    console.error("[auth/me]", e);
    res.status(500).json({ ok:false, error:"me_failed" });
  }
});

/* ------------ Password reset (request + perform) ------------ */
router.post("/request-reset", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.json({ ok: true }); // do not reveal existence
    const u = await pool.query("SELECT id FROM public.users WHERE lower(email)=$1", [email]);
    if (!u.rowCount) return res.json({ ok: true });

    const token = crypto.randomBytes(24).toString("hex");
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    await pool.query(
      `INSERT INTO public.password_resets (email, token, expires_at) VALUES ($1,$2,$3)`,
      [email, token, expires]
    );

    // In production you would email this link. For dev, echo it so your frontend can show it.
    const origin = process.env.PUBLIC_FRONTEND_ORIGIN || "";
    const link = `${origin}/reset.html?token=${token}`;
    res.json({ ok: true, reset_link: link });
  } catch (e) {
    console.error("[auth/request-reset]", e);
    res.status(500).json({ ok:false, error:"request_reset_failed" });
  }
});

router.post("/perform-reset", async (req, res) => {
  try {
    const { token, new_password } = req.body || {};
    if (!token || !new_password) return res.status(400).json({ ok:false, error:"missing_fields" });

    const r = await pool.query(
      `SELECT * FROM public.password_resets
       WHERE token=$1 AND used=FALSE AND expires_at > now()`,
      [token]
    );
    if (!r.rowCount) return res.status(400).json({ ok:false, error:"token_invalid" });

    const row = r.rows[0];
    const hash = await bcrypt.hash(new_password, 11);
    await pool.query(`UPDATE public.users SET password_hash=$1 WHERE lower(email)=lower($2)`, [hash, row.email]);
    await pool.query(`UPDATE public.password_resets SET used=TRUE WHERE id=$1`, [row.id]);

    res.json({ ok:true });
  } catch (e) {
    console.error("[auth/perform-reset]", e);
    res.status(500).json({ ok:false, error:"perform_reset_failed" });
  }
});

export default router;
