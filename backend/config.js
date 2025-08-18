// backend/config.js
export function getConfig() {
  return {
    currency: "gbp",
    lead_minutes: 24 * 60, // 24h lead
    families: {
      // Weekdays (Mon–Fri)
      weekday_75:  ["16:00","17:45","19:45"],
      weekday_120: ["16:00","18:30"],
      // Weekends (Sat–Sun)
      weekend_75:  ["09:00","10:45","12:30","14:15","16:00","17:45"],
      weekend_120: ["09:00","11:30","14:00","16:30"]
    },
    services: {
      exterior: { name: "Exterior Detail", duration: 75, price: 40 },
      full: { name: "Full Detail", duration: 120, price: 60 },
      standard_membership: {
        name: "Standard Membership (2 Exterior visits)",
        duration: 75, visits: 2, visitService: "exterior", price: 70
      },
      premium_membership: {
        name: "Premium Membership (2 Full visits)",
        duration: 120, visits: 2, visitService: "full", price: 100
      }
    },
    addons: {
      wax:   { name: "Full Body Wax", price: 15 },
      polish:{ name: "Hand Polish",   price: 15 }
    }
  };
}
