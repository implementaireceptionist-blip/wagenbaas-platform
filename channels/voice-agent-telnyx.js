/**
 * voice-agent-telnyx.js
 * ─────────────────────────────────────────────────────────────
 * Telnyx Media Streams  ←→  Deepgram Voice Agent API
 *
 * Flow:
 *   Dutch number (+31 ...) → Telnyx
 *   → POST /api/telnyx/voice   (TeXML webhook)
 *   → WS  /api/telnyx/stream   (Telnyx Media Streams)
 *   → WSS agent.deepgram.com/agent
 *   → mulaw audio back to Telnyx → caller hears AI
 */

const url        = require("url");
const WS         = require("ws");
const Anthropic  = require("@anthropic-ai/sdk");
const { db }     = require("../database");

const CHANNEL = "voice-agent";
const DG_URL  = "wss://agent.deepgram.com/agent";

// callControlId → fromNumber (set by webhook before WS connects)
const pendingCalls = new Map();

// sessionId → [{role, content}]  — live transcript per call
const callHistory  = new Map();

// ── System prompt (voice-optimised) ──────────────────────────────────────────
function getPrompt() {
  return process.env.VOICE_AGENT_PROMPT || `
You are the AI receptionist of Wagenbaas, an auto repair garage in Apeldoorn, Netherlands. You speak over the phone.

LANGUAGE: Always respond in the caller's language (NL / EN / DE / FR). Default to Dutch.

VOICE RULES (CRITICAL):
- Keep every response to 1–2 sentences, unless caller asks for more detail.
- No markdown, no bullet points, no asterisks — spoken audio only.
- Speak naturally and conversationally.
- Spell out all numbers and times as words.
- LISTENING: When a caller spells out a phone number, email, or license plate letter by letter — stay completely silent and wait until they fully finish. Never interrupt mid-spelling.
- After the caller stops speaking, pause 1–2 seconds before responding to make sure they are done.
- If caller says something and pauses briefly, wait — they may be thinking or continuing.

BUSINESS INFO:
- Address: Molenmakershoek 10, 7328 JK Apeldoorn
- Phone: +31 64 77 000 88
- Email: info@wagenbaas.nl
- Hours: Monday–Friday 08:30–18:00 | Saturday 09:00–18:00 | Sunday closed

SERVICES: APK keuring, onderhoud, reparatie, banden, airco.

PRIMARY GOAL — BOOK THE APPOINTMENT:
Collect in this order (max 2 questions at once):
1. Name + phone number (always first)
2. License plate + preferred date and time
3. Service needed

Validate date/time against business hours. Suggest "tomorrow at 10:00" or "Friday at 14:00" if unclear.

NEVER LOSE A LEAD:
- If not ready to book: ask name + phone for follow-up.
- After every answer, steer back to booking.

IF CALLER WANTS A HUMAN:
Ask for name + phone, say "Een medewerker belt u zo snel mogelijk terug."

CLOSING: Always end with "Is er nog iets anders waar ik u mee kan helpen?"
`.trim();
}

// ── Deepgram Voice Agent settings ─────────────────────────────────────────────
// Only documented Deepgram Voice Agent API params — extras cause SettingsApplied
// to silently fail which breaks listen/speak behaviour entirely.
function buildSettings() {
  const sttModel = process.env.DEEPGRAM_AGENT_STT_MODEL || "nova-3";
  const llmModel = process.env.DEEPGRAM_AGENT_LLM_MODEL || "claude-haiku-4-5-20251001";
  const ttsModel = process.env.DEEPGRAM_AGENT_TTS_MODEL || "aura-2-thalia-en";
  const temp     = parseFloat(process.env.DEEPGRAM_AGENT_TEMPERATURE || "0.3");
  const greeting = process.env.VOICE_AGENT_GREETING || "Goedendag, u bent verbonden met Wagenbaas. Hoe kan ik u helpen?";

  return {
    type: "Settings",
    audio: {
      input:  { encoding: "mulaw", sample_rate: 8000 },
      output: { encoding: "mulaw", sample_rate: 8000, container: "none" },
    },
    agent: {
      listen: {
        provider: {
          type:        "deepgram",
          model:       sttModel,
          language:    "multi",
          // 1.9s silence → end of utterance (important for phone number spelling)
          endpointing: 1900,
        },
      },
      think: {
        provider: {
          type:        "anthropic",
          model:       llmModel,
          temperature: temp,
        },
        prompt: getPrompt(),
      },
      speak: {
        provider: {
          type:  "deepgram",
          model: ttsModel,
        },
      },
      // Barge-in: stop AI speech immediately when caller speaks
      interrupt_sensitivity: "high",
      greeting,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function escXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nowIso() { return new Date().toISOString(); }

function dbLog(sessionId, msg) {
  try {
    db.insertMessage({
      $session_id: sessionId, $channel: CHANNEL,
      $direction: "outbound", $from_id: "system",
      $from_name: "Voice Agent",
      $content: `[${nowIso()}] ${msg}`,
    });
  } catch {}
}

function dbTranscript(sessionId, role, content, fromNumber) {
  try {
    db.insertMessage({
      $session_id: sessionId, $channel: CHANNEL,
      $direction:  role === "user" ? "inbound" : "outbound",
      $from_id:    role === "user" ? (fromNumber || sessionId) : "wagenbaas-agent",
      $from_name:  role === "user" ? (fromNumber || "Caller")  : "Wagenbaas AI",
      $content:    content,
    });
  } catch {}
}

// ── Appointment extraction from voice transcript ──────────────────────────────
// Keywords that suggest appointment intent — trigger extraction
const APPT_KEYWORDS = /\b(afspraak|appointment|boek|book|datum|date|tijd|time|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|monday|tuesday|wednesday|thursday|friday|saturday|morgen|tomorrow|volgende week|next week|apk|onderhoud|reparatie|banden|airco|naam|name|telefoon|phone|kenteken|license)\b/i;

async function extractAndSave(sessionId, history, fromNumber) {
  if (history.length < 2) return;

  const fullText = history.map(h => `${h.role.toUpperCase()}: ${h.content}`).join("\n");
  if (!APPT_KEYWORDS.test(fullText)) return;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return;

  try {
    const client = new Anthropic({ apiKey: key });
    const response = await client.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `Extract appointment data from this phone call transcript. Return ONLY valid JSON or the word null.

TRANSCRIPT:
${fullText}

Return JSON (use null for unknown fields):
{
  "name": string|null,
  "phone": string|null,
  "email": string|null,
  "license": string|null,
  "service": string|null,
  "pref_date": "YYYY-MM-DD"|null,
  "pref_time": "HH:MM"|null,
  "notes": string|null,
  "confidence": "low"|"medium"|"high",
  "type": "appointment"|"lead"|"callback"|"none"
}

confidence = high if name+phone+date confirmed, medium if partial, low if just intent.
Return null if no booking intent at all.`,
      }],
    });

    const raw = response.content[0]?.text?.trim();
    if (!raw || raw === "null") return;

    const data = safeJSON(raw);
    if (!data || data.type === "none") return;

    const phone = data.phone || fromNumber || "";

    if (data.type === "appointment" || data.confidence !== "low") {
      db.upsertVoiceAppointment({
        $session_id: sessionId,
        $name:       data.name       || "",
        $phone:      phone,
        $email:      data.email      || "",
        $license:    data.license    || "",
        $service:    data.service    || "",
        $pref_date:  data.pref_date  || "",
        $pref_time:  data.pref_time  || "",
        $notes:      data.notes      || "",
        $channel:    CHANNEL,
        $confidence: data.confidence || "low",
      });
      console.log(`[VoiceTelnyx:${sessionId}] Appointment upserted — confidence:${data.confidence} type:${data.type}`);
    }

    // Also save as lead if we have at least a name or phone
    if ((data.name || phone) && data.type !== "none") {
      const existing = db.findLeadByContact({ $phone: phone, $email: data.email || "" });
      if (!existing) {
        db.insertLead({
          $name:   data.name  || "",
          $phone:  phone,
          $email:  data.email || "",
          $source: CHANNEL,
          $notes:  `Voice call. Service: ${data.service || "?"}. Date: ${data.pref_date || "?"}`,
        });
      }
    }

    // Save callback intent
    if (data.type === "callback" && phone) {
      db.insertCallback({
        $name:    data.name   || "",
        $phone:   phone,
        $reason:  data.notes  || "Callback requested via voice",
        $channel: CHANNEL,
      });
    }

  } catch (err) {
    console.error(`[VoiceTelnyx:${sessionId}] Extraction error:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function register(app, { server } = {}) {
  if (!server) throw new Error("[voice-agent-telnyx] requires { server }");

  // ── 1. TeXML Webhook — inbound call ─────────────────────────────────────────
  app.post("/api/telnyx/voice", (req, res) => {
    const host    = req.headers["x-forwarded-host"] || req.headers.host;
    const proto   = (req.headers["x-forwarded-proto"] || "https").toLowerCase();
    const wsProto = proto === "http" ? "ws" : "wss";

    const callId = req.body?.CallControlId || req.body?.call_control_id || "";
    const from   = req.body?.From || req.body?.from || "";

    if (callId) pendingCalls.set(callId, from);

    const streamUrl = `${wsProto}://${host}/api/telnyx/stream?callId=${encodeURIComponent(callId)}`;
    const statusUrl = `${proto}://${host}/api/telnyx/status`;

    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${streamUrl}" statusCallbackUrl="${escXml(statusUrl)}" />
  </Start>
  <Pause length="300"/>
</Response>`;

    res.type("text/xml").send(texml);
  });

  // ── 2. Call Status Webhook ───────────────────────────────────────────────────
  app.post("/api/telnyx/status", (req, res) => {
    const eventType   = req.body?.data?.event_type || req.body?.event_type || "";
    const payload     = req.body?.data?.payload     || req.body || {};
    const hangupCause = payload?.hangup_cause        || payload?.CallStatus || "";
    const from        = payload?.from || payload?.From || "";
    const callId      = payload?.call_control_id || payload?.CallControlId || "";
    const duration    = parseInt(payload?.call_duration_secs || payload?.CallDuration || "0", 10);

    const missedCauses = ["call_rejected", "no_answer", "user_busy", "originator_cancel", "failed"];
    const isMissed = missedCauses.some(c => hangupCause.toLowerCase().includes(c));

    if (isMissed || (eventType === "call.hangup" && duration < 5)) {
      try {
        db.insertMissedCall({ $caller: from, $call_sid: callId, $status: "gemist", $duration: duration });
        db.insertStat({ $event: "missed_call", $channel: CHANNEL, $meta: from || null });
        console.log(`[VoiceTelnyx] Missed call from ${from} — cause: ${hangupCause || "short call"}`);
      } catch (e) {
        console.error("[VoiceTelnyx] Failed to log missed call:", e.message);
      }
    }

    res.sendStatus(204);
  });

  // ── 3. WebSocket Server — Telnyx Media Streams ───────────────────────────────
  const wss = new WS.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = url.parse(req.url || "");
    if (pathname !== "/api/telnyx/stream") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (telnyxWs, req) => {
    const qs         = new URLSearchParams((url.parse(req.url || "").query) || "");
    const callId     = qs.get("callId") || "";
    let   streamId   = null;
    let   fromNumber = pendingCalls.get(callId) || "";
    let   sessionId  = callId || `vt_${Date.now()}`;
    let   dgWs       = null;
    let   keepAlive  = null;

    // Live transcript buffer for this call
    callHistory.set(sessionId, []);

    const log = (msg) => {
      console.log(`[VoiceTelnyx:${sessionId}] ${msg}`);
      dbLog(sessionId, msg);
    };

    function connectDG() {
      const key = process.env.DEEPGRAM_API_KEY;
      if (!key) { log("ERROR: DEEPGRAM_API_KEY not set"); telnyxWs.close(); return; }

      dgWs = new WS(DG_URL, { headers: { Authorization: `Token ${key}` } });

      dgWs.on("open", () => {
        log("Deepgram Voice Agent connected — sending Settings");
        dgWs.send(JSON.stringify(buildSettings()));

        keepAlive = setInterval(() => {
          if (dgWs.readyState === WS.OPEN) dgWs.send(JSON.stringify({ type: "KeepAlive" }));
        }, 5000);
      });

      dgWs.on("message", (data, isBinary) => {
        // Binary = TTS audio → forward to Telnyx caller
        if (isBinary || Buffer.isBuffer(data)) {
          if (telnyxWs.readyState === WS.OPEN && streamId) {
            const payload = (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("base64");
            telnyxWs.send(JSON.stringify({ event: "media", stream_id: streamId, media: { payload } }));
          }
          return;
        }

        const msg = safeJSON(data.toString("utf8"));
        if (!msg) return;

        switch (msg.type) {
          case "Welcome":
            log("Deepgram: Welcome");
            break;

          case "SettingsApplied":
            log("Deepgram: Settings applied — agent ready");
            break;

          case "ConversationText": {
            if (!msg.content) break;
            const role = msg.role === "user" ? "user" : "agent";
            console.log(`[VoiceTelnyx transcript] ${role}: ${msg.content}`);
            dbTranscript(sessionId, role, msg.content, fromNumber);

            // Append to live history
            const history = callHistory.get(sessionId) || [];
            history.push({ role, content: msg.content });
            callHistory.set(sessionId, history);

            // After agent speaks (= full turn complete), try to extract appointment data
            if (role === "agent") {
              extractAndSave(sessionId, history, fromNumber).catch(() => {});
            }
            break;
          }

          case "UserStartedSpeaking":
            log("Barge-in — caller is speaking");
            break;

          case "AgentStartedSpeaking":
            log("Agent speaking");
            break;

          case "Error":
            log(`Deepgram error: ${msg.message || JSON.stringify(msg)}`);
            break;
        }
      });

      dgWs.on("error", (e) => log(`Deepgram WS error: ${e.message}`));
      dgWs.on("close", (code) => {
        log(`Deepgram WS closed (code ${code})`);
        clearInterval(keepAlive);
      });
    }

    // ── Handle Telnyx events ────────────────────────────────────────────────
    telnyxWs.on("message", (raw) => {
      const msg = safeJSON(raw.toString("utf8"));
      if (!msg || !msg.event) return;

      switch (msg.event) {
        case "connected":
          break;

        case "start":
          streamId   = msg.stream_id || null;
          fromNumber = msg?.start?.from || pendingCalls.get(callId) || fromNumber;
          sessionId  = msg?.start?.call_control_id || callId || sessionId;

          // Re-key history if sessionId changed
          if (!callHistory.has(sessionId)) callHistory.set(sessionId, []);

          log(`Call started — from=${fromNumber || "?"} streamId=${streamId}`);
          db.insertStat?.({ $event: "voice_agent_call", $channel: CHANNEL, $meta: fromNumber || null });
          connectDG();
          break;

        case "media":
          // Forward caller audio to Deepgram — always, even while AI is speaking
          if (!dgWs || dgWs.readyState !== WS.OPEN) return;
          {
            const audio = Buffer.from(msg.media?.payload || "", "base64");
            try { dgWs.send(audio); } catch {}
          }
          break;

        case "stop":
          log("Call ended");
          // Final extraction pass on full transcript
          {
            const history = callHistory.get(sessionId) || [];
            extractAndSave(sessionId, history, fromNumber)
              .catch(() => {})
              .finally(() => {
                callHistory.delete(sessionId);
                cleanup();
                pendingCalls.delete(callId);
              });
          }
          break;
      }
    });

    telnyxWs.on("close", () => {
      log("Telnyx WS closed");
      const history = callHistory.get(sessionId) || [];
      extractAndSave(sessionId, history, fromNumber).catch(() => {});
      callHistory.delete(sessionId);
      cleanup();
      pendingCalls.delete(callId);
    });

    telnyxWs.on("error", (e) => {
      try { log(`Telnyx WS error: ${e.message}`); } catch {}
    });

    function cleanup() {
      clearInterval(keepAlive);
      try { if (dgWs) dgWs.close(); } catch {}
    }
  });

  console.log("📞 Voice Agent (Telnyx + Deepgram) registered");
  console.log("   Webhook : POST /api/telnyx/voice");
  console.log("   Stream  : WS   /api/telnyx/stream");
  console.log("   Status  : POST /api/telnyx/status");
}

module.exports = { register };
