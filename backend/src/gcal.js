// backend/src/gcal.js
import { google } from "googleapis";
import { createHash } from "crypto";

const TZ = "Europe/London";
const cfg = {
  email: process.env.GCAL_CLIENT_EMAIL,
  key: process.env.GCAL_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  calId: process.env.GCAL_CALENDAR_ID,
};

let calendar = null;

function ready() { return Boolean(cfg.email && cfg.key && cfg.calId); }
function client() {
  if (!ready()) return null;
  if (calendar) return calendar;
  const jwt = new google.auth.JWT({
    email: cfg.email,
    key: cfg.key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  calendar = google.calendar({ version: "v3", auth: jwt });
  return calendar;
}
function eventId(sessionId, index) {
  // Make a-z0-9 only, start with a letter, >= 5 chars
  const hex = createHash("sha1").update(String(sessionId) + ":" + String(index)).digest("hex"); // a-f0-9
  return `g${hex.slice(0, 23)}${index}`; // e.g. g3f2e…7
}

export async function createCalendarEvents(sessionId, items = []) {
  if (!ready()) { console.warn("[gcal] not configured; skipping"); return; }
  const api = client();
  for (let i = 0; i < items.length; i++) {
    const evId = eventId(sessionId, i + 1);
    const it = items[i];
    const body = {
      id: evId,
      summary: it.summary || "GM Auto Detailing",
      description: it.description || "",
      location: it.location || "",
      start: { dateTime: it.start_iso, timeZone: TZ },
      end:   { dateTime: it.end_iso,   timeZone: TZ },
    };
    try {
      await api.events.insert({ calendarId: cfg.calId, requestBody: body });
      console.log("[gcal] created", evId);
    } catch (e) {
      if (e?.code === 409) console.log("[gcal] exists", evId);
      else console.warn("[gcal] insert failed", e?.message || e);
    }
  }
}
