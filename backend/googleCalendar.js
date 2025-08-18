// backend/googleCalendar.js
export async function listBusyIntervals(startISO, endISO) {
  // Return [] = nothing busy (so all canonical slots show)
  // Replace with real Google Calendar freeBusy later.
  return [];
}
export async function createCalendarEvent({ service_key, addons, customer, start_iso, end_iso }) {
  // No-op for now; when you connect Google Calendar, insert the event here.
  console.log("[createCalendarEvent] mock insert", { service_key, start_iso, end_iso, name: customer?.name });
  return { ok: true };
}
