// backend/src/gcal.js
import { createHash } from "crypto";

const TZ = "Europe/London";
const cfg = {
  email: process.env.GCAL_CLIENT_EMAIL,
  key: process.env.GCAL_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  calId: process.env.GCAL_CALENDAR_ID,
};

let googleCached = null;
let calendar = null;

function ready() {
  return Boolean(cfg.email && cfg.key && cfg.calId);
}

async function getGoogle() {
  if (googleCached) return googleCached;
  try {
    // Lazy import so the process does not crash if the module is missing
    const mod = await import("googleapis");
    googleCached = mod.google;
    return googleCached;
  } catch (e) {
    console.warn("[gcal] 'googleapis' not available; calendar sync disabled.");
    return null;
  }
}

async function client() {
  if (!ready()) {
    console.warn("[gcal] not configured; skipping");
    return null;
  }
  if (calendar) return calendar;

  const google = await getGoogle();
  if (!google) return null;

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
  const hex = createHash("sha1").update(String(sessionId) + ":" + String(index)).digest("hex");
  return `g${hex.slice(0, 23)}${index}`;
}

export async function createCalendarEvents(sessionId, items = []) {
  const api = await client();
  if (!api) return; // not configured or module missing

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
