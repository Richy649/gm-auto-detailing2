// backend/src/auth.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "./db.js";

const router = Router();

/**
 * Enforce a single source of truth for JWT signing/verification.
 * This avoids silent fallbacks that cause token verification mismatches.
 */
if (!process.env.JWT_SECRET) {
  // Fail fast during boot if misconfigured.
  throw new Error("JWT_SECRET must be set in the environment");
}
const JWT_SECRET = process.env.JWT_SECRET;

/* --------------------------- Helpers --------------------------- */
function signToken(user) {
  // Keep your 30-day TTL unchanged.
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
}

/**
 * Authorization middleware:
 * - Accepts "Authorization: Bearer <token>".
 * - On success, sets req.user = { id, email }.
 * - On failure, does not throw; it simply leaves req.user undefined.
 *   (Endpoints that require auth will still 401.)
 */
export async function authMiddleware(req, _res, next) {
  try {
    const h = req.headers.authorization || "";
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (!m) return next();
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = { id: payload.id, email: payload.email };
  } catch (err) {
    // Intentionally do not block the request here; protected routes will 401.
    // Provide a compact log for diagnostics without leaking token content.
    console.warn("[authMiddleware] invalid or expired token");
  }
  next();
}

/* --------------------------- Routes ---------------------------- */

/**
 * POST /api/auth/register
 * Body: { email, password, name?, phone?, street?, postcode? }
 */
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, phone, street, postcode } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const existing = await pool.query(
      "SELECT 1 FROM public.users WHERE lower(email)=lower($1)",
      [email]
    );
    if (existing.rowCount) {
      return res.status(409).json({ ok: false, error: "email_in_use" });
    }

    const hash = await bcrypt.hash(password, 11);
    const r = await pool.query(
      `INSERT INTO public.users (email,password_hash,name,phone,street,postcode)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [email, hash, name || null, phone || null, street || null, postcode || null]
    );

    return res.json({ ok: true, token: signToken(r.rows[0]) });
  } catch (e) {
    console.error("[auth/register]", e);
    return res.status(500).json({ ok: false, error: "register_failed" });
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Success: { ok:true, token }
 * Failure: 401 with { ok:false, error:"invalid_creds" }
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const r = await pool.query(
      "SELECT * FROM public.users WHERE lower(email)=lower($1)",
      [email]
    );
    if (!r.rowCount) {
      // Avoid leaking which part failed for security parity.
      return res.status(401).json({ ok: false, error: "invalid_creds" });
    }

    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash || "");
    if (!ok) {
      return res.status(401).json({ ok: false, error: "invalid_creds" });
    }

    return res.json({ ok: true, token: signToken(u) });
  } catch (e) {
    console.error("[auth/login]", e);
    return res.status(500).json({ ok: false, error: "login_failed" });
  }
});

/**
 * GET /api/auth/me
 * Uses authMiddleware; returns profile, credits, and active subscriptions.
 */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "auth_required" });
    }

    const u = await pool.query(
      "SELECT id,email,name,phone,street,postcode FROM public.users WHERE id=$1",
      [req.user.id]
    );
    if (!u.rowCount) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    // Live credits summary via your ledger
    const c = await pool.query(
      `SELECT service_type, COALESCE(SUM(qty),0) AS bal
         FROM public.credit_ledger
        WHERE user_id=$1
          AND (valid_until IS NULL OR valid_until > now())
        GROUP BY service_type`,
      [req.user.id]
    );
    const credits = { exterior: 0, full: 0 };
    for (const row of c.rows) credits[row.service_type] = Number(row.bal || 0);

    // Active/trialing/past_due subscriptions for UI decisions
    const subs = await pool.query(
      `SELECT tier, status,
              EXTRACT(EPOCH FROM current_period_start)::bigint AS current_period_start,
              EXTRACT(EPOCH FROM current_period_end)::bigint   AS current_period_end
         FROM public.subscriptions
        WHERE user_id=$1
          AND status IN ('active','trialing','past_due')
        ORDER BY updated_at DESC NULLS LAST`,
      [req.user.id]
    );

    return res.json({ ok: true, user: u.rows[0], credits, subscriptions: subs.rows || [] });
  } catch (e) {
    console.error("[auth/me]", e);
    return res.status(500).json({ ok: false, error: "me_failed" });
  }
});

/**
 * PUT /api/auth/me
 * Body: { name?, phone?, street?, postcode?, new_password? }
 */
router.put("/me", authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "auth_required" });
    }

    const { name, phone, street, postcode, new_password } = req.body || {};
    const updates = [];
    const params = [];
    let idx = 1;

    if (typeof name === "string")     { updates.push(`name=$${idx++}`);     params.push(name || null); }
    if (typeof phone === "string")    { updates.push(`phone=$${idx++}`);    params.push(phone || null); }
    if (typeof street === "string")   { updates.push(`street=$${idx++}`);   params.push(street || null); }
    if (typeof postcode === "string") { updates.push(`postcode=$${idx++}`); params.push(postcode || null); }

    if (new_password && typeof new_password === "string") {
      if (new_password.length < 8) {
        return res.status(400).json({ ok: false, error: "password_too_short" });
      }
      const hash = await bcrypt.hash(new_password, 11);
      updates.push(`password_hash=$${idx++}`);
      params.push(hash);
    }

    if (updates.length) {
      params.push(req.user.id);
      const sql = `UPDATE public.users SET ${updates.join(", ")}, updated_at=now() WHERE id=$${idx}`;
      await pool.query(sql, params);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[auth PUT /me]", e);
    return res.status(500).json({ ok: false, error: "update_failed" });
  }
});

export default router;
