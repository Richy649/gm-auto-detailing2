export const WORKING_HOURS = {
  1: { start: "15:40", end: "21:00" },
  2: { start: "15:40", end: "21:00" },
  3: { start: "15:40", end: "21:00" },
  4: { start: "15:40", end: "21:00" },
  5: { start: "15:40", end: "21:00" },
  6: { start: "09:00", end: "19:30" },
  0: { start: "09:00", end: "19:30" }
};
export const BUFFER_MINUTES = 20;
export const MAX_DAYS_AHEAD = 30;

export const SERVICES = {
  exterior: { name: "Exterior Detail", duration: 60, price: 60 },
  full: { name: "Full Detail", duration: 120, price: 120 },
  standard_membership: { name: "Standard Membership", includes: ["exterior","exterior"], price: 100 },
  premium_membership: { name: "Premium Membership", includes: ["full","full"], price: 220 }
};
export const ADDONS = {
  wax: { name: "Full Body Wax", extraMinutes: 15, price: 15 },
  polish: { name: "Hand Polish", extraMinutes: 15, price: 15 }
};

