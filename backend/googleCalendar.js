// backend/googleCalendar.js
// Stub implementations; replace with real Google Calendar later.
export async function listBusyIntervals(_startISO, _endISO) {
  return []; // nothing is busy by default
}
export async function createCalendarEvent({ service_key, start_iso, end_iso, customer }) {
  console.log("[Mock GCal] create event", { service_key, start_iso, end_iso, name: customer?.name });
  return { ok: true };
}
