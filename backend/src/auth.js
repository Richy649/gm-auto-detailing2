// backend/src/auth.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "./db.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

/* ---------- JWT helpers ---------- */
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

/* ---------- ensure password_resets table (lazy) ---------- */
async function ensureResetTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_pwreset_token ON public.password_resets (token_hash);
    CREATE INDEX IF NOT EXISTS idx_pwreset_user ON public.password_resets (user_id);
  `);
}

/* ---------- register/login/me ---------- */
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

/* ---------- profile update (name/phone/address) ---------- */
router.post("/profile", authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });
    const { name, phone, street, postcode } = req.body || {};
    await pool.query(
      `UPDATE public.users SET
         name=COALESCE($2,name),
         phone=COALESCE($3,phone),
         street=COALESCE($4,street),
         postcode=COALESCE($5,postcode)
       WHERE id=$1`,
      [req.user.id, name||null, phone||null, street||null, postcode||null]
    );
    res.json({ ok:true });
  } catch (e) {
    console.error("[auth/profile]", e);
    res.status(500).json({ ok:false, error:"profile_update_failed" });
  }
});

/* ---------- change password (logged-in) ---------- */
router.post("/change-password", authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) return res.status(400).json({ ok:false, error:"missing_fields" });

    const r = await pool.query("SELECT * FROM public.users WHERE id=$1", [req.user.id]);
    const u = r.rows[0];
    const ok = await bcrypt.compare(current_password, u.password_hash || "");
    if (!ok) return res.status(401).json({ ok:false, error:"invalid_current_password" });

    const hash = await bcrypt.hash(new_password, 11);
    await pool.query("UPDATE public.users SET password_hash=$2 WHERE id=$1", [req.user.id, hash]);
    res.json({ ok:true });
  } catch (e) {
    console.error("[auth/change-password]", e);
    res.status(500).json({ ok:false, error:"change_password_failed" });
  }
});

/* ---------- request password reset (public) ---------- */
router.post("/request-reset", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok:false, error:"missing_email" });
    const rr = await pool.query("SELECT id,email FROM public.users WHERE lower(email)=lower($1)", [email]);
    if (!rr.rowCount) {
      // Pretend success to avoid account enumeration
      return res.json({ ok:true });
    }
    await ensureResetTable();

    const user_id = rr.rows[0].id;
    const token = crypto.randomBytes(32).toString("hex");
    const token_hash = crypto.createHash("sha256").update(token).digest("hex");
    const expires_at = new Date(Date.now() + 1000 * 60 * 30); // 30 min

    // invalidate older tokens for this user
    await pool.query("UPDATE public.password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [user_id]);

    await pool.query(
      `INSERT INTO public.password_resets (user_id, token_hash, expires_at)
       VALUES ($1,$2,$3)`,
      [user_id, token_hash, expires_at]
    );

    const link = `${process.env.PUBLIC_FRONTEND_ORIGIN || ""}/reset.html?token=${token}`;

    // In production you would SEND EMAIL with the link.
    // For now we return ok, and optionally include the link if DEV_RETURN_RESET_LINK=1
    const devReturn = process.env.DEV_RETURN_RESET_LINK === "1";
    res.json({ ok:true, ...(devReturn ? { reset_link: link } : {}) });
  } catch (e) {
    console.error("[auth/request-reset]", e);
    res.status(500).json({ ok:false, error:"request_reset_failed" });
  }
});

/* ---------- perform password reset (public) ---------- */
router.post("/perform-reset", async (req, res) => {
  try {
    const { token, new_password } = req.body || {};
    if (!token || !new_password) return res.status(400).json({ ok:false, error:"missing_fields" });

    await ensureResetTable();
    const token_hash = crypto.createHash("sha256").update(token).digest("hex");
    const r = await pool.query(
      `SELECT * FROM public.password_resets
       WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()
       ORDER BY id DESC LIMIT 1`,
      [token_hash]
    );
    if (!r.rowCount) return res.status(400).json({ ok:false, error:"invalid_or_expired" });

    const pr = r.rows[0];
    const hash = await bcrypt.hash(new_password, 11);

    await pool.query("UPDATE public.users SET password_hash=$2 WHERE id=$1", [pr.user_id, hash]);
    await pool.query("UPDATE public.password_resets SET used_at=now() WHERE id=$1", [pr.id]);

    res.json({ ok:true });
  } catch (e) {
    console.error("[auth/perform-reset]", e);
    res.status(500).json({ ok:false, error:"perform_reset_failed" });
  }
});

export default router;
