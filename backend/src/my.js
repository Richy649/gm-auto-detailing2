
// backend/src/my.js
import { Router } from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";

const router = Router();
router.use(authMiddleware);

// Recent bookings for the logged-in user
router.get("/bookings", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });

    const lim = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
    const ur = await pool.query("SELECT email FROM public.users WHERE id=$1", [req.user.id]);
    const email = (ur.rows[0]?.email || "").toLowerCase();

    const r = await pool.query(
      `SELECT id, service_key, start_time, end_time, addons, created_at
         FROM public.bookings
        WHERE user_id = $1
           OR (lower(customer_email) = $2 AND $2 <> '')
        ORDER BY start_time DESC NULLS LAST, id DESC
        LIMIT $3`,
      [req.user.id, email, lim]
    );
    res.json({ ok:true, rows: r.rows || [] });
  } catch (e) {
    console.error("[my/bookings]", e);
    res.status(500).json({ ok:false, error:"my_bookings_failed" });
  }
});

// Next upcoming booking (soonest future start_time)
router.get("/bookings/upcoming", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok:false, error:"auth_required" });

    const ur = await pool.query("SELECT email FROM public.users WHERE id=$1", [req.user.id]);
    const email = (ur.rows[0]?.email || "").toLowerCase();

    const q = `
      SELECT id, service_key, start_time, end_time, addons
        FROM public.bookings
       WHERE (user_id = $1 OR (lower(customer_email) = $2 AND $2 <> ''))
         AND start_time IS NOT NULL
         AND start_time > now()
       ORDER BY start_time ASC
       LIMIT 1
    `;
    const r = await pool.query(q, [req.user.id, email]);
    res.json({ ok:true, booking: r.rows[0] || null });
  } catch (e) {
    console.error("[my/bookings/upcoming]", e);
    res.status(500).json({ ok:false, error:"upcoming_failed" });
  }
});

export default router;
