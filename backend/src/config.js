// Strong defaults so /api/config is never empty
export const WORKING_HOURS = {
  1: { start: "15:40", end: "21:00" }, // Mon
  2: { start: "15:40", end: "21:00" }, // Tue
  3: { start: "15:40", end: "21:00" }, // Wed
  4: { start: "15:40", end: "21:00" }, // Thu
  5: { start: "15:40", end: "21:00" }, // Fri
  6: { start: "09:00", end: "19:30" }, // Sat
  0: { start: "09:00", end: "19:30" }, // Sun
};

export const BUFFER_MINUTES = 20;
export const MAX_DAYS_AHEAD = 30;

// SERVICES you can tweak later — these WILL appear in the UI
export const SERVICES = {
  exterior: { name: "Exterior Detail", duration: 60, price: 60 },
  full: { name: "Full Detail", duration: 120, price: 120 },
  standard_membership: {
    name: "Standard Membership",
    includes: ["exterior", "exterior"], // 2 visits
    price: 100,
  },
  premium_membership: {
    name: "Premium Membership",
    includes: ["full", "full"], // 2 visits
    price: 220,
  },
};

// Optional add-ons
export const ADDONS = {
  wax: { name: "Full Body Wax", extraMinutes: 15, price: 15 },
  polish: { name: "Hand Polish", extraMinutes: 15, price: 15 },
};
