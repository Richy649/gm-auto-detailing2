// backend/src/gcal.js
import { google } from "googleapis";

function getJWT() {
  const client_email = process.env.GCAL_CLIENT_EMAIL;
  let private_key = process.env.GCAL_PRIVATE_KEY || "";
  private_key = private_key.replace(/\\n/g, "\n");
  if (!client_email || !private_key) {
    console.warn("[gcal] Missing GCAL_CLIENT_EMAIL/GCAL_PRIVATE_KEY");
    return null;
  }
  return new google.auth.JWT({
    email: client_email,
    key: private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

export async function createCalendarEvent({ summary, description, location, startISO, endISO }) {
  const jwt = getJWT();
  const calendarId = process.env.GCAL_CALENDAR_ID;
  if (!jwt || !calendarId) {
    console.warn("[gcal] Not configured; skip event create");
    return null;
  }
  const cal = google.calendar({ version: "v3", auth: jwt });
  const ev = await cal.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      location,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
    },
  });
  return ev.data;
}
