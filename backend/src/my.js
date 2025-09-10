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

export default router;
