// backend/src/gcal.js
// Safe placeholders so the backend runs without Google setup.

export async function listBusyIntervals(_startISO, _endISO) {
  // Return [] = nothing is busy; all canonical slots are available.
  return [];
}

export async function createCalendarEvent({ service_key, addons, customer, start_iso, end_iso }) {
  // No-op for now. When you connect Google, we’ll insert the real event.
  console.log("[Mock GCal] create event", {
    service_key,
    start_iso,
    end_iso,
    name: customer?.name,
    addons
  });
  return { ok: true };
}
