import { Router } from "express";
import { listRecentBookings } from "./db.js";

const router = Router();
const TOKEN = process.env.ADMIN_TOKEN || "";

router.get("/recent", async (req, res) => {
  if (!TOKEN || req.query.token !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  const lim = Number(req.query.limit || 10);
  const rows = await listRecentBookings(lim);
  res.json({ rows });
});

export default router;
