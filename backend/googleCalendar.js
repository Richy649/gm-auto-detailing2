import { google } from "googleapis";

const GCAL_CALENDAR_ID = process.env.GCAL_CALENDAR_ID;
const GCAL_TIMEZONE = process.env.GCAL_TIMEZONE || "Europe/London";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !GCAL_CALENDAR_ID) {
  console.warn("[Google Calendar] Missing env vars; events will not be created.");
}

function getOAuth2Client() {
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

export async function createCalendarEvent({ service_key, addons, customer, start_iso, end_iso }) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !GCAL_CALENDAR_ID) return;

  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });

  const title = `Detailing: ${service_key.replace(/_/g, " ")} — ${customer?.name || "Client"}`;
  const description = [
    `Service: ${service_key}`,
    addons?.length ? `Add-ons: ${addons.join(", ")}` : "Add-ons: none",
    "",
    "Client:",
    `• Name: ${customer?.name || "-"}`,
    `• Phone: ${customer?.phone || "-"}`,
    `• Email: ${customer?.email || "-"}`,
    `• Address: ${customer?.address || "-"}`,
  ].join("\n");

  await calendar.events.insert({
    calendarId: GCAL_CALENDAR_ID,
    requestBody: {
      summary: title,
      description,
      start: { dateTime: start_iso, timeZone: GCAL_TIMEZONE },
      end:   { dateTime: end_iso,   timeZone: GCAL_TIMEZONE },
      location: customer?.address || "",
      reminders: { useDefault: true },
    },
  });
}
