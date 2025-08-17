// Business hours (edit these to your real hours if needed)
export const WORKING_HOURS = {
  1: { start: "15:40", end: "21:00" }, // Mon
  2: { start: "15:40", end: "21:00" }, // Tue
  3: { start: "15:40", end: "21:00" }, // Wed
  4: { start: "15:40", end: "21:00" }, // Thu
  5: { start: "15:40", end: "21:00" }, // Fri
  6: { start: "09:00", end: "19:30" }, // Sat
  0: { start: "09:00", end: "19:30" }, // Sun
};

// Buffers & window
export const BUFFER_MINUTES = 20;   // gap before/after each job
export const MAX_DAYS_AHEAD = 30;   // book up to 30 days ahead

// Services & durations (PER VISIT)
export const SERVICES = {
  exterior: { name: "Exterior Detail", duration: 75, price: 60 },
  full:     { name: "Full Detail",     duration: 120, price: 120 },

  // Memberships are TWO SEPARATE VISITS.
  // We set duration to the per-visit length so availability works correctly.
  standard_membership: {
    name: "Standard Membership (2 visits of Exterior Detail)",
    duration: 75,     // per visit
    visits: 2,
    visitService: "exterior",
    price: 100
  },
  premium_membership: {
    name: "Premium Membership (2 visits of Full Detail)",
    duration: 120,    // per visit
    visits: 2,
    visitService: "full",
    price: 220
  },
};

// Optional add-ons
export const ADDONS = {
  wax:    { name: "Full Body Wax", extraMinutes: 15, price: 15 },
  polish: { name: "Hand Polish",   extraMinutes: 15, price: 15 },
};
