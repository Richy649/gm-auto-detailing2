
// backend/src/gcal.js
import { google } from "googleapis";

const TZ = "Europe/London";

const cfg = {
  email: process.env.GCAL_CLIENT_EMAIL,
  key: process.env.GCAL_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  calId: process.env.GCAL_CALENDAR_ID,
};

let calendar = null;

function ready() {
  return Boolean(cfg.email && cfg.key && cfg.calId);
}

function getClient() {
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

function sanitizeId(s) {
  // Google event id: 5–1024 chars, lowercase a-z, 0-9, -_
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 128) || `gm-${Date.now()}`;
}

/**
 * Create events idempotently. If the event id already exists, we treat it as success.
 * @param {string} sessionId - Stripe session id
 * @param {Array<{start_iso:string,end_iso:string,summary:string,description:string,location?:string}>} items
 */
export async function createCalendarEvents(sessionId, items = []) {
  if (!ready()) {
    console.warn("[gcal] not configured; skipping");
    return;
  }
  const cli = getClient();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const eventId = sanitizeId(`gm-${sessionId}-${i + 1}`);
    const resource = {
      id: eventId,
      summary: it.summary || "GM Auto Detailing",
      description: it.description || "",
      location: it.location || "",
      start: { dateTime: it.start_iso, timeZone: TZ },
      end:   { dateTime: it.end_iso,   timeZone: TZ },
    };
    try {
      await cli.events.insert({
        calendarId: cfg.calId,
        requestBody: resource,
        supportsAttachments: false,
      });
      console.log("[gcal] created", eventId);
    } catch (e) {
      if (e?.code === 409) {
        console.log("[gcal] exists", eventId);
      } else {
        console.warn("[gcal] insert failed", e?.message || e);
      }
    }
  }
}
