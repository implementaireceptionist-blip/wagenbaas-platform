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
 *
 * Why Telnyx over Twilio:
 *   - Dutch (+31) numbers available
 *   - $0.004/min inbound (vs $0.0085 Twilio)
 *   - $20 free credit on signup
 *   - Carrier-grade quality in NL
 *
 * Latency stack:
 *   STT : Deepgram nova-3 (multi-lang NL/EN/DE/FR)
 *   LLM : Anthropic Claude Haiku 4.5 (via Deepgram Voice Agent)
 *   TTS : Deepgram Aura-2 (<200 ms)
 *   Audio: mulaw 8kHz — Telnyx native format
 * ─────────────────────────────────────────────────────────────
 */

const url  = require("url");
const WS   = require("ws");
const { db } = require("../database");

const CHANNEL = "voice-agent";
const DG_URL  = "wss://agent.deepgram.com/agent";

// callControlId → fromNumber (set by webhook before WS connects)
const pendingCalls = new Map();

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

// ── Deepgram Voice Agent settings ────────────────────────────────────────────
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
          type:             "deepgram",
          model:            sttModel,
          language:         "multi",
          // Wait 1.4s of silence before treating utterance as complete —
          // critical for spelling out phone numbers / emails letter by letter
          endpointing:      1400,
          // Extra buffer after final word — catches trailing digits / letters
          utterance_end_ms: 2000,
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
        // Slightly slower speech (0.9x) — clearer for non-native speakers
        speed: 0.9,
      },
      // Stop AI audio immediately when caller starts speaking (barge-in)
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

// ─────────────────────────────────────────────────────────────────────────────
function register(app, { server } = {}) {
  if (!server) throw new Error("[voice-agent-telnyx] requires { server }");

  // ── 1. TeXML Webhook — inbound call ─────────────────────────────────────────
  app.post("/api/telnyx/voice", (req, res) => {
    const host      = req.headers["x-forwarded-host"] || req.headers.host;
    const proto     = (req.headers["x-forwarded-proto"] || "https").toLowerCase();
    const wsProto   = proto === "http" ? "ws" : "wss";

    // Telnyx sends call_control_id in body for TeXML calls
    const callId    = req.body?.CallControlId || req.body?.call_control_id || "";
    const from      = req.body?.From || req.body?.from || "";

    if (callId) pendingCalls.set(callId, from);

    const streamUrl = `${wsProto}://${host}/api/telnyx/stream?callId=${encodeURIComponent(callId)}`;
    const statusUrl = `${proto}://${host}/api/telnyx/status`;

    // Telnyx TeXML: <Start><Stream> to open media stream, then <Pause> to keep call alive
    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${streamUrl}" statusCallbackUrl="${escXml(statusUrl)}" />
  </Start>
  <Pause length="300"/>
</Response>`;

    res.type("text/xml").send(texml);
  });

  // ── 2. Call Status Webhook — missed / failed calls ───────────────────────────
  app.post("/api/telnyx/status", (req, res) => {
    // Telnyx sends either TeXML statusCallback or webhook events
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
        db.insertMissedCall({
          $caller:   from,
          $call_sid: callId,
          $status:   "gemist",
          $duration: duration,
        });
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

    const log = (msg) => {
      console.log(`[VoiceTelnyx:${sessionId}] ${msg}`);
      dbLog(sessionId, msg);
    };

    function connectDG() {
      const key = process.env.DEEPGRAM_API_KEY;
      if (!key) {
        log("ERROR: DEEPGRAM_API_KEY not set");
        telnyxWs.close();
        return;
      }

      dgWs = new WS(DG_URL, { headers: { Authorization: `Token ${key}` } });

      dgWs.on("open", () => {
        log("Deepgram Voice Agent connected — sending Settings");
        dgWs.send(JSON.stringify(buildSettings()));

        keepAlive = setInterval(() => {
          if (dgWs.readyState === WS.OPEN) {
            dgWs.send(JSON.stringify({ type: "KeepAlive" }));
          }
        }, 5000);
      });

      dgWs.on("message", (data, isBinary) => {
        // Binary = audio → forward to Telnyx
        if (isBinary || Buffer.isBuffer(data)) {
          if (telnyxWs.readyState === WS.OPEN && streamId) {
            const payload = (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("base64");
            telnyxWs.send(JSON.stringify({
              event:     "media",
              stream_id: streamId,
              media:     { payload },
            }));
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
          case "ConversationText":
            if (msg.content) {
              const role = msg.role === "user" ? "user" : "agent";
              console.log(`[VoiceTelnyx transcript] ${role}: ${msg.content}`);
              dbTranscript(sessionId, role, msg.content, fromNumber);
            }
            break;
          case "UserStartedSpeaking":
            log("Barge-in detected");
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

    // ── Handle Telnyx events ──────────────────────────────────────────────────
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

          log(`Call started — from=${fromNumber || "?"} streamId=${streamId}`);
          db.insertStat?.({ $event: "voice_agent_call", $channel: CHANNEL, $meta: fromNumber || null });
          connectDG();
          break;

        case "media":
          if (!dgWs || dgWs.readyState !== WS.OPEN) return;
          {
            const audio = Buffer.from(msg.media?.payload || "", "base64");
            try { dgWs.send(audio); } catch {}
          }
          break;

        case "stop":
          log("Call ended");
          cleanup();
          pendingCalls.delete(callId);
          break;
      }
    });

    telnyxWs.on("close", () => {
      log("Telnyx WS closed");
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
