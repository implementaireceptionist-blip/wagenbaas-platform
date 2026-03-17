require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { initDB, db } = require("./database");
const { getAIReply, extractData, cleanReply, AI_PROVIDER } = require("./ai");
const { registerCalendarRoutes, isSlotAvailable, createAppointmentEvent } = require("./calendar");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "wagenbaas-admin-2024";

// ── Security headers — no CSP so the chat widget works freely ─────────────────
app.use(helmet({
  contentSecurityPolicy: false,        // CSP was breaking the chat UI
  crossOriginEmbedderPolicy: false,
}));
app.disable("x-powered-by");

// ── Admin brute-force protection ──────────────────────────────────────────────
const adminFailures = new Map();

function adminBruteCheck(req, res, next) {
  const ip = req.ip || "unknown";
  const entry = adminFailures.get(ip) || { count: 0, blockedUntil: 0 };
  if (entry.blockedUntil > Date.now()) {
    const secs = Math.ceil((entry.blockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${secs}s.` });
  }
  req._adminIp = ip;
  next();
}
function recordAdminFailure(ip) {
  const e = adminFailures.get(ip) || { count: 0, blockedUntil: 0 };
  e.count += 1;
  if (e.count >= 10) e.blockedUntil = Date.now() + 30 * 60 * 1000;
  else if (e.count >= 5) e.blockedUntil = Date.now() + 5 * 60 * 1000;
  adminFailures.set(ip, e);
}
function clearAdminFailure(ip) { adminFailures.delete(ip); }

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({
  limit: "10kb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use("/api/", rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
}));

app.use("/api/admin/", rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { error: "Admin rate limit exceeded." },
}));

registerCalendarRoutes(app);

// ── Load enabled channels ─────────────────────────────────────────────────────
const channels = {
  sms:              process.env.ENABLE_SMS              === "true",
  email:            process.env.ENABLE_EMAIL            === "true",
  whatsapp:         process.env.ENABLE_WHATSAPP         === "true",
  facebook:         process.env.ENABLE_FACEBOOK         === "true",
  instagram:        process.env.ENABLE_INSTAGRAM        === "true",
  voice:            process.env.ENABLE_VOICE            === "true",
  voiceAgentTelnyx: process.env.ENABLE_VOICE_TELNYX     === "true",
  voiceAgent:       process.env.ENABLE_VOICE_AGENT      === "true",
  voiceAgentBrowser:process.env.ENABLE_VOICE_AGENT      === "true",
};

if (channels.sms)               require("./channels/sms").register(app);
if (channels.email)             require("./channels/email").register(app);
if (channels.whatsapp)          require("./channels/whatsapp").register(app);
if (channels.facebook)          require("./channels/facebook").register(app);
if (channels.instagram)         require("./channels/instagram").register(app);
if (channels.voice)             require("./channels/voice").register(app, { server });
if (channels.voiceAgentTelnyx)  require("./channels/voice-agent-telnyx").register(app, { server });
if (channels.voiceAgent)        require("./channels/voice-agent-twilio").register(app, { server });
if (channels.voiceAgentBrowser) require("./channels/voice-agent-browser").register(app, { server });

// ── Welcome ───────────────────────────────────────────────────────────────────
app.get("/api/welcome", (req, res) => {
  res.json({ message: "Welkom. How can I help you with?" });
});

// ── Main Chat API ─────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { messages, sessionId, channel = "webchat" } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "Ongeldig formaat." });

  const valid = messages.every(m =>
    (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()
  );
  if (!valid) return res.status(400).json({ error: "Ongeldig formaat." });

  const sid = sessionId || crypto.randomUUID();
  const trimmed = messages.slice(-20);
  const lastMsg = trimmed[trimmed.length - 1];

  if (lastMsg?.role === "user") {
    db.insertMessage({ $session_id: sid, $channel: channel, $direction: "inbound", $from_id: sid, $from_name: "Klant", $content: lastMsg.content });
    db.insertStat({ $event: "message_sent", $channel: channel, $meta: null });
  }

  try {
    const rawReply = await getAIReply(trimmed);
    const { appointment, lead, callback } = extractData(rawReply);
    const reply = cleanReply(rawReply);

    db.insertMessage({ $session_id: sid, $channel: channel, $direction: "outbound", $from_id: "wagenbaas", $from_name: "Wagenbaas AI", $content: reply });

    if (appointment) {
      const date = appointment.pref_date || "";
      const time = appointment.pref_time || "";
      const hasDateTime = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time);

      if (hasDateTime && process.env.GOOGLE_REFRESH_TOKEN) {
        const availability = await isSlotAvailable({ date, time, durationMinutes: 60 });
        if (availability.ok && availability.available === false) {
          const msg = "That time is not available. Please suggest another date/time within our opening hours.";
          return res.json({ reply: `${reply}\n\n${msg}`, sessionId: sid, appointment: false, callback: !!callback, lead: !!lead, slotUnavailable: true });
        }
      }

      db.insertAppointment({ $name: appointment.name||"", $phone: appointment.phone||"", $email: appointment.email||"", $car_brand: appointment.car_brand||"", $car_model: appointment.car_model||"", $car_year: appointment.car_year||"", $license: appointment.license||"", $service: appointment.service||"", $pref_date: appointment.pref_date||"", $pref_time: appointment.pref_time||"", $notes: appointment.notes||"", $channel: channel });
      db.insertStat({ $event: "appointment_booked", $channel: channel, $meta: appointment.service });

      if (hasDateTime && process.env.GOOGLE_REFRESH_TOKEN) {
        const summary = `Wagenbaas afspraak: ${appointment.service || "Service"} (${appointment.license || "zonder kenteken"})`;
        const description = [
          `Naam: ${appointment.name || ""}`,
          `Telefoon: ${appointment.phone || ""}`,
          `Email: ${appointment.email || ""}`,
          `Kenteken: ${appointment.license || ""}`,
          `Auto: ${[appointment.car_brand, appointment.car_model, appointment.car_year].filter(Boolean).join(" ")}`,
          `Notities: ${appointment.notes || ""}`,
          `Kanaal: ${channel}`,
        ].filter(Boolean).join("\n");
        await createAppointmentEvent({
          summary, description, date, time, durationMinutes: 60,
          attendees: appointment.email ? [{ email: appointment.email }] : [],
        });
      }
    }
    if (callback) {
      db.insertCallback({ $name: callback.name||"", $phone: callback.phone||"", $reason: callback.reason||"", $channel: channel });
      db.insertStat({ $event: "callback_requested", $channel: channel, $meta: callback.phone });
    }
    if (lead) {
      const baseLead = { $name: lead.name||"", $phone: lead.phone||"", $email: lead.email||"", $source: channel, $notes: lead.notes||"" };
      const existingLead = db.findLeadByContact({ $phone: baseLead.$phone, $email: baseLead.$email });
      if (existingLead) db.updateLead({ ...baseLead, $id: existingLead.id });
      else db.insertLead(baseLead);
      db.insertStat({ $event: "lead_captured", $channel: channel, $meta: baseLead.$phone || baseLead.$email || null });
    }

    res.json({ reply, sessionId: sid, appointment: !!appointment, callback: !!callback, lead: !!lead });

  } catch (err) {
    console.error("AI error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again or contact us at +31 64 77 000 88." });
  }
});

// ── Admin Auth ────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  adminBruteCheck(req, res, () => {
    const token = req.headers["x-admin-token"] || req.query.token;
    if (!token || token !== ADMIN_TOKEN) {
      recordAdminFailure(req._adminIp || req.ip);
      return res.status(401).json({ error: "Unauthorized" });
    }
    clearAdminFailure(req._adminIp || req.ip);
    next();
  });
}

// ── Admin API ─────────────────────────────────────────────────────────────────
app.get("/api/admin/dashboard", adminAuth, (req, res) => {
  res.json({
    appointments:   db.allAppointments(),
    callbacks:      db.allCallbacks(),
    leads:          db.allLeads(),
    messages:       db.allMessages(),
    missedCalls:    db.allMissedCalls(),
    stats:          db.statsCount(),
    todayStats:     db.todayStats(),
    channelStats:   db.channelStats(),
    activeChannels: channels,
    aiProvider:     AI_PROVIDER,
  });
});

app.patch("/api/admin/missed-calls/:id", adminAuth, (req, res) => {
  const { status } = req.body;
  if (!["gemist","teruggebeld","afgerond"].includes(status)) return res.status(400).json({ error: "Ongeldige status" });
  db.updateMissedCallStatus({ $status: status, $id: req.params.id });
  res.json({ ok: true });
});

app.patch("/api/admin/appointments/:id", adminAuth, (req, res) => {
  const { status } = req.body;
  if (!["nieuw","bevestigd","afgerond","geannuleerd"].includes(status)) return res.status(400).json({ error: "Ongeldige status" });
  db.updateAppointmentStatus({ $status: status, $id: req.params.id });
  res.json({ ok: true });
});

app.patch("/api/admin/callbacks/:id", adminAuth, (req, res) => {
  const { status } = req.body;
  if (!["te bellen","gebeld","afgerond"].includes(status)) return res.status(400).json({ error: "Ongeldige status" });
  db.updateCallbackStatus({ $status: status, $id: req.params.id });
  res.json({ ok: true });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok", provider: AI_PROVIDER, channels }));
app.get("/tiktok", (req, res) => res.sendFile(path.join(__dirname, "public", "tiktok.html")));
app.get("/boek", (req, res) => res.sendFile(path.join(__dirname, "public", "tiktok.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🚗 Wagenbaas Platform → http://localhost:${PORT}`);
    console.log(`🤖 AI: ${AI_PROVIDER.toUpperCase()}`);
    console.log(`🎵 TikTok booking page → http://localhost:${PORT}/tiktok`);
    console.log(`🔐 Admin → http://localhost:${PORT}/admin  (token: ${ADMIN_TOKEN})`);
    console.log(`\n📡 Actieve kanalen:`);
    Object.entries(channels).forEach(([k,v]) => console.log(`   ${v ? '✅' : '⬜'} ${k}`));
    console.log('');
  });
}).catch(err => { console.error("DB error:", err); process.exit(1); });
