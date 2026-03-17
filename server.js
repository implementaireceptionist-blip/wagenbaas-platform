require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const slowDown = require("express-slow-down");
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

// ── Security Headers (helmet) ─────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],  // needed for inline chat widget
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", "data:", "https:"],
      connectSrc:  ["'self'", "wss:", "https:"],
      fontSrc:     ["'self'", "https:", "data:"],
      objectSrc:   ["'none'"],
      frameSrc:    ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,  // allow widget embeds
}));

// Hide server fingerprint
app.disable("x-powered-by");

// ── Brute-force tracking for admin ────────────────────────────────────────────
const adminFailures = new Map(); // ip → { count, blockedUntil }

function adminBruteCheck(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = adminFailures.get(ip) || { count: 0, blockedUntil: 0 };

  if (entry.blockedUntil > now) {
    const wait = Math.ceil((entry.blockedUntil - now) / 1000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });
  }
  req._adminIp = ip;
  next();
}

function recordAdminFailure(ip) {
  const entry = adminFailures.get(ip) || { count: 0, blockedUntil: 0 };
  entry.count += 1;
  // Block for 5 min after 5 failures, 30 min after 10
  if (entry.count >= 10) entry.blockedUntil = Date.now() + 30 * 60 * 1000;
  else if (entry.count >= 5) entry.blockedUntil = Date.now() + 5 * 60 * 1000;
  adminFailures.set(ip, entry);
}

function clearAdminFailure(ip) {
  adminFailures.delete(ip);
}

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({
  limit: "10kb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: "50kb" }));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// General API: 60 requests / 10 min per IP
app.use("/api/", rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
}));

// Chat: slow down after 10 requests, hard limit at 30 / 10 min
app.use("/api/chat", slowDown({
  windowMs: 10 * 60 * 1000,
  delayAfter: 10,
  delayMs: () => 500,
}));
app.use("/api/chat", rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { error: "Chat limit reached. Please wait a moment." },
}));

// Admin: max 20 requests / 10 min
app.use("/api/admin/", rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { error: "Admin rate limit exceeded." },
}));

// Webhooks: max 200 / min (Telnyx can burst)
app.use("/api/telnyx/", rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: "Webhook rate limit exceeded." },
}));

// ── Block obviously malicious user-agents ─────────────────────────────────────
const BAD_UA = /sqlmap|nikto|nmap|masscan|zgrab|python-requests\/2\.[0-4]|curl\/7\.[0-5]/i;
app.use((req, res, next) => {
  const ua = req.headers["user-agent"] || "";
  if (BAD_UA.test(ua)) return res.status(403).json({ error: "Forbidden" });
  next();
});

// ── Sanitize string inputs (strip null bytes + oversized fields) ───────────────
function sanitize(val, maxLen = 2000) {
  if (typeof val !== "string") return val;
  return val.replace(/\0/g, "").slice(0, maxLen);
}

app.use((req, _res, next) => {
  if (req.body && typeof req.body === "object") {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === "string") req.body[key] = sanitize(req.body[key]);
    }
  }
  next();
});

registerCalendarRoutes(app);

// ── Load enabled channels ─────────────────────────────────────────────────────
const channels = {
  sms:              process.env.ENABLE_SMS              === "true",
  email:            process.env.ENABLE_EMAIL            === "true",
  whatsapp:         process.env.ENABLE_WHATSAPP         === "true",
  facebook:         process.env.ENABLE_FACEBOOK         === "true",
  instagram:        process.env.ENABLE_INSTAGRAM        === "true",
  voice:            process.env.ENABLE_VOICE            === "true",        // Telnyx (legacy)
  voiceAgentTelnyx: process.env.ENABLE_VOICE_TELNYX     === "true",        // Telnyx + Deepgram (recommended)
  voiceAgent:       process.env.ENABLE_VOICE_AGENT      === "true",        // Twilio + Deepgram
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
  res.json({
    message: "Welkom. How can I help you with?"
  });
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
          summary,
          description,
          date,
          time,
          durationMinutes: 60,
          attendees: appointment.email ? [{ email: appointment.email }] : [],
        });
      }
    }
    if (callback) {
      db.insertCallback({ $name: callback.name||"", $phone: callback.phone||"", $reason: callback.reason||"", $channel: channel });
      db.insertStat({ $event: "callback_requested", $channel: channel, $meta: callback.phone });
    }
    if (lead) {
      const baseLead = {
        $name:  lead.name  || "",
        $phone: lead.phone || "",
        $email: lead.email || "",
        $source: channel,
        $notes: lead.notes || "",
      };
      const existingLead = db.findLeadByContact({ $phone: baseLead.$phone, $email: baseLead.$email });
      if (existingLead) {
        db.updateLead({ ...baseLead, $id: existingLead.id });
      } else {
        db.insertLead(baseLead);
      }
      db.insertStat({ $event: "lead_captured", $channel: channel, $meta: baseLead.$phone || baseLead.$email || null });
    }

    res.json({ reply, sessionId: sid, appointment: !!appointment, callback: !!callback, lead: !!lead });

  } catch (err) {
    console.error("AI error:", err.message);
    res.status(500).json({ error: "Er is een fout opgetreden. Controleer uw API sleutel." });
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
    console.log(`\n🚗 Implementit Platform → http://localhost:${PORT}`);
    console.log(`🤖 AI: ${AI_PROVIDER.toUpperCase()}`);
    console.log(`🎵 TikTok booking page → http://localhost:${PORT}/tiktok`);
    console.log(`🔐 Admin → http://localhost:${PORT}/admin  (token: ${ADMIN_TOKEN})`);
    console.log(`\n📡 Actieve kanalen:`);
    Object.entries(channels).forEach(([k,v]) => console.log(`   ${v ? '✅' : '⬜'} ${k}`));
    console.log('');
  });
}).catch(err => { console.error("DB error:", err); process.exit(1); });
