import { google } from 'googleapis';

function getAuth() {
  const clientEmail = process.env.GCAL_CLIENT_EMAIL;
  const privateKey = (process.env.GCAL_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) return null;

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

/**
 * Return busy intervals from Google Calendar between [timeMin, timeMax).
 * Each item: { start: Date, end: Date }
 */
export async function getGCalBusy(timeMinISO, timeMaxISO) {
  const calendarId = process.env.GCAL_CALENDAR_ID;
  const auth = getAuth();
  if (!auth || !calendarId) return []; // Not configured = no extra busy blocks

  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.list({
    calendarId,
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    singleEvents: true,
    orderBy: 'startTime',
    showDeleted: false
  });

  const items = res.data.items || [];
  const blocks = [];
  for (const ev of items) {
    if (ev.status === 'cancelled') continue;
    // Treat all events as busy unless explicitly transparent
    if (ev.transparency === 'transparent') continue;

    const s = ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null);
    const e = ev.end?.dateTime   || (ev.end?.date   ? `${ev.end.date}T00:00:00Z`   : null);
    if (!s || !e) continue;
    const start = new Date(s);
    const end   = new Date(e);
    if (isFinite(start) && isFinite(end) && start < end) {
      blocks.push({ start, end });
    }
  }
  return blocks;
}
