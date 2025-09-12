import * as db from "./db.js";

/**
 * I keep the functions minimal and database-agnostic, assuming your `users` table
 * holds integer columns for `exterior_credits` and `full_credits`. If your schema
 * differs, adjust the UPDATE statements accordingly.
 */

export async function addExteriorCredits(userId, count) {
  await db.query(
    "UPDATE users SET exterior_credits = COALESCE(exterior_credits, 0) + $1 WHERE id=$2",
    [count, userId]
  );
}

export async function addFullCredits(userId, count) {
  await db.query(
    "UPDATE users SET full_credits = COALESCE(full_credits, 0) + $1 WHERE id=$2",
    [count, userId]
  );
}

export async function awardCreditsForTier(userId, tier) {
  if (tier === "standard") {
    // 2 exterior credits per billing period
    await addExteriorCredits(userId, 2);
  } else if (tier === "premium") {
    // 2 full-detail credits per billing period
    await addFullCredits(userId, 2);
  }
}
