// WIDE TEST HOURS so slots definitely appear (we can tighten later)
export const WORKING_HOURS = {
  0: { start: "09:00", end: "20:00" }, // Sun
  1: { start: "09:00", end: "20:00" }, // Mon
  2: { start: "09:00", end: "20:00" }, // Tue
  3: { start: "09:00", end: "20:00" }, // Wed
  4: { start: "09:00", end: "20:00" }, // Thu
  5: { start: "09:00", end: "20:00" }, // Fri
  6: { start: "09:00", end: "20:00" }, // Sat
};

// Keep the rules; we’ll limit to 30 days and 24h minimum on the server
export const BUFFER_MINUTES = 5;    // small buffer for testing; increase later
export const MAX_DAYS_AHEAD = 30;

// Your real durations PER VISIT
export const SERVICES = {
  exterior: { name: "Exterior Detail", duration: 75, price: 60 },
  full:     { name: "Full Detail",     duration: 120, price: 120 },

  // Memberships = two separate visits (per-visit duration)
  standard_membership: {
    name: "Standard Membership (2 Exterior visits)",
    duration: 75, visits: 2, visitService: "exterior", price: 100
  },
  premium_membership: {
    name: "Premium Membership (2 Full visits)",
    duration: 120, visits: 2, visitService: "full", price: 220
  },
};

export const ADDONS = {
  wax:    { name: "Full Body Wax", extraMinutes: 15, price: 15 },
  polish: { name: "Hand Polish",   extraMinutes: 15, price: 15 },
};
