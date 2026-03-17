const { google } = require("googleapis");

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getCalendarClient() {
  const oauth2 = getOAuth2Client();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!oauth2 || !refreshToken) return null;
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth: oauth2 });
}

function calendarId() {
  return process.env.GOOGLE_CALENDAR_ID || "primary";
}

function toIsoLocal(dateStr, timeStr, tz) {
  // dateStr: YYYY-MM-DD, timeStr: HH:MM
  return `${dateStr}T${timeStr}:00`;
}

function addMinutes(isoLocal, minutes) {
  const d = new Date(isoLocal);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

async function isSlotAvailable({ date, time, durationMinutes = 60, timeZone = "Europe/Amsterdam" }) {
  const cal = getCalendarClient();
  if (!cal) return { ok: false, reason: "calendar_not_configured" };

  const startLocal = toIsoLocal(date, time, timeZone);
  const start = new Date(startLocal);
  if (Number.isNaN(start.getTime())) return { ok: false, reason: "invalid_datetime" };
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone,
      items: [{ id: calendarId() }],
    },
  });

  const busy = res?.data?.calendars?.[calendarId()]?.busy || [];
  const available = busy.length === 0;
  return { ok: true, available, start: start.toISOString(), end: end.toISOString(), busy };
}

async function createAppointmentEvent({ summary, description, date, time, durationMinutes = 60, timeZone = "Europe/Amsterdam", attendees = [] }) {
  const cal = getCalendarClient();
  if (!cal) return { ok: false, reason: "calendar_not_configured" };

  const startLocal = toIsoLocal(date, time, timeZone);
  const start = new Date(startLocal);
  if (Number.isNaN(start.getTime())) return { ok: false, reason: "invalid_datetime" };
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  const res = await cal.events.insert({
    calendarId: calendarId(),
    requestBody: {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone },
      end: { dateTime: end.toISOString(), timeZone },
      attendees: attendees.filter(a => a && a.email).map(a => ({ email: a.email })),
    },
  });

  return { ok: true, eventId: res.data.id, htmlLink: res.data.htmlLink };
}

function registerCalendarRoutes(app) {
  const oauth2 = getOAuth2Client();
  if (!oauth2) return;

  app.get("/api/calendar/auth", (req, res) => {
    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/calendar"],
    });
    res.json({ url });
  });

  app.get("/api/calendar/oauth2callback", async (req, res) => {
    try {
      const code = req.query.code;
      if (!code) return res.status(400).json({ error: "Missing code" });
      const { tokens } = await oauth2.getToken(code);
      res.json({
        tokens,
        instructions: "Copy tokens.refresh_token into GOOGLE_REFRESH_TOKEN in Render/.env. Keep it secret.",
      });
    } catch (err) {
      console.error("Calendar OAuth error:", err.message);
      res.status(500).json({ error: "OAuth failed" });
    }
  });
}

module.exports = {
  registerCalendarRoutes,
  isSlotAvailable,
  createAppointmentEvent,
};

