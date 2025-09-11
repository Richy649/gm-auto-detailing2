import db from "./db.js";

// Helper functions
export async function addExteriorCredits(userId, count) {
  await db.query("UPDATE users SET exterior_credits = exterior_credits + $1 WHERE id=$2", [
    count,
    userId,
  ]);
}
export async function addFullCredits(userId, count) {
  await db.query("UPDATE users SET full_credits = full_credits + $1 WHERE id=$2", [
    count,
    userId,
  ]);
}

export async function awardCreditsForTier(userId, tier) {
  if (tier === "standard") {
    await addExteriorCredits(userId, 2);
  } else if (tier === "premium") {
    await addFullCredits(userId, 2);
  }
}

// Stripe webhook handler
export async function handleMembershipWebhook(event) {
  switch (event.type) {
    case "invoice.payment_succeeded": {
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription;
      if (!subscriptionId) return;

      // Retrieve subscription from Stripe
      const stripe = new (await import("stripe")).default(
        process.env.STRIPE_SECRET_KEY,
        { apiVersion: "2024-06-20" }
      );
      const sub = await stripe.subscriptions.retrieve(subscriptionId);

      const customerId = sub.customer;
      const priceId = sub.items.data[0].price.id;

      // Map priceId back to tier
      let tier = null;
      if (
        [process.env.STANDARD_PRICE, process.env.STANDARD_INTRO_PRICE].includes(priceId)
      ) {
        tier = "standard";
      } else if (
        [process.env.PREMIUM_PRICE, process.env.PREMIUM_INTRO_PRICE].includes(priceId)
      ) {
        tier = "premium";
      }

      if (!tier) return;

      // Find user in DB
      const userRes = await db.query(
        "SELECT id FROM users WHERE stripe_customer_id=$1 LIMIT 1",
        [customerId]
      );
      if (userRes.rows.length === 0) return;

      const userId = userRes.rows[0].id;

      // Award credits
      await awardCreditsForTier(userId, tier);

      console.log(`Awarded credits to user ${userId} for tier ${tier}`);
      break;
    }

    default:
      console.log(`Unhandled event type ${event.type}`);
  }
}
