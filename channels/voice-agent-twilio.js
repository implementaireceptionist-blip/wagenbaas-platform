/**
 * voice-agent-twilio.js
 * ─────────────────────────────────────────────────────────────
 * Twilio Media Streams  ←→  Deepgram Voice Agent API
 *
 * Flow:
 *   +40752859831 (call forward) → Twilio number
 *   → POST /api/twilio/voice   (TwiML webhook)
 *   → WS  /api/twilio/stream   (Media Streams)
 *   → WSS agent.deepgram.com/agent
 *   → mulaw audio back to Twilio → caller hears AI
 *
 * Latency stack (lowest possible):
 *   STT : Deepgram nova-3 / Flux (env: DEEPGRAM_AGENT_STT_MODEL)
 *   LLM : Anthropic Claude Haiku 4.5
 *   TTS : Deepgram Aura-2 (<200 ms)
 *   Audio: mulaw 8kHz — no transcoding needed (Twilio native format)
 * ─────────────────────────────────────────────────────────────
 */

const url  = require("url");
const WS   = require("ws");
const { db } = require("../database");

const CHANNEL    = "voice-agent";
const DG_URL     = "wss://agent.deepgram.com/agent";

// Pending calls map: callSid → fromNumber (populated by webhook before WS connects)
const pendingCalls = new Map();

// ── System prompt (voice-optimised) ──────────────────────────────────────────
function getPrompt() {
  return process.env.VOICE_AGENT_PROMPT || `
You are the AI receptionist of Wagenbaas, an auto repair garage in Apeldoorn, Netherlands. You speak over the phone.

LANGUAGE: Always respond in the caller's language (NL / EN / DE / FR). Default to Dutch.

VOICE RULES (CRITICAL):
- Keep every response to 1–2 sentences, under 120 characters, unless the caller asks for more detail.
- No markdown, no bullet points, no asterisks — this is spoken audio only.
- Speak naturally and conversationally.
- Spell out all numbers and times as words.

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

// ── Deepgram Voice Agent Settings ────────────────────────────────────────────
function buildSettings() {
  const sttModel  = process.env.DEEPGRAM_AGENT_STT_MODEL  || "nova-3";
  const llmModel  = process.env.DEEPGRAM_AGENT_LLM_MODEL  || "claude-haiku-4-5-20251001";
  const ttsModel  = process.env.DEEPGRAM_AGENT_TTS_MODEL  || "aura-2-thalia-en";
  const temp      = parseFloat(process.env.DEEPGRAM_AGENT_TEMPERATURE || "0.3");
  const greeting  = process.env.VOICE_AGENT_GREETING || "Goedendag, u bent verbonden met Wagenbaas. Hoe kan ik u helpen?";

  return {
    type: "Settings",

    // ── AUDIO ─────────────────────────────────────────────────────────────────
    // Twilio sends mulaw 8 kHz — accept it natively, no transcoding needed.
    // DG returns mulaw 8 kHz → forward directly to Twilio.
    audio: {
      input:  { encoding: "mulaw", sample_rate: 8000 },
      output: { encoding: "mulaw", sample_rate: 8000, container: "none" },
    },

    // ── AGENT ─────────────────────────────────────────────────────────────────
    agent: {
      listen: {
        provider: {
          type:     "deepgram",
          model:    sttModel,        // nova-3 → set DEEPGRAM_AGENT_STT_MODEL=flux for max speed
          language: "multi",         // auto-detect NL / EN / DE / FR
        },
      },
      think: {
        provider: {
          type:        "anthropic",
          model:       llmModel,     // claude-haiku-4-5-20251001
          temperature: temp,         // 0.3 = fast, consistent phone replies
        },
        prompt: getPrompt(),
      },
      speak: {
        provider: {
          type:  "deepgram",
          model: ttsModel,           // aura-2-thalia-en (sub-200 ms TTS)
        },
      },
      greeting: greeting,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function nowIso() { return new Date().toISOString(); }

function dbLog(sessionId, msg) {
  try {
    db.insertMessage({
      $session_id: sessionId,
      $channel:    CHANNEL,
      $direction:  "outbound",
      $from_id:    "system",
      $from_name:  "Voice Agent",
      $content:    `[${nowIso()}] ${msg}`,
    });
  } catch {}
}

function dbTranscript(sessionId, role, content, fromNumber) {
  try {
    db.insertMessage({
      $session_id: sessionId,
      $channel:    CHANNEL,
      $direction:  role === "user" ? "inbound" : "outbound",
      $from_id:    role === "user" ? (fromNumber || sessionId) : "wagenbaas-agent",
      $from_name:  role === "user" ? (fromNumber || "Beller") : "Wagenbaas AI",
      $content:    content,
    });
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
function register(app, { server } = {}) {
  if (!server) throw new Error("[voice-agent-twilio] requires { server }");

  // ── 1. TwiML Webhook — inbound call ────────────────────────────────────────
  app.post("/api/twilio/voice", (req, res) => {
    const host     = req.headers["x-forwarded-host"] || req.headers.host;
    const proto    = (req.headers["x-forwarded-proto"] || "https").toLowerCase();
    const wsProto  = proto === "http" ? "ws" : "wss";
    const callSid  = req.body?.CallSid || "";
    const from     = req.body?.From    || "";

    // Store caller number so the WebSocket handler can retrieve it
    if (callSid) pendingCalls.set(callSid, from);

    // Stream URL receives the callSid as a query param so we can look up the caller
    const streamUrl = `${wsProto}://${host}/api/twilio/stream?callSid=${encodeURIComponent(callSid)}`;
    const statusUrl = `${proto}://${host}/api/twilio/status`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" statusCallback="${statusUrl}" />
  </Connect>
</Response>`;

    res.type("text/xml").send(twiml);
  });

  // ── 1b. Call Status Callback — missed / completed calls ─────────────────────
  app.post("/api/twilio/status", (req, res) => {
    const status   = (req.body?.CallStatus || "").toLowerCase();
    const callSid  = req.body?.CallSid    || "";
    const from     = req.body?.From       || pendingCalls.get(callSid) || "";
    const duration = parseInt(req.body?.CallDuration || "0", 10);

    // Log missed/no-answer/busy/failed calls
    if (["no-answer", "busy", "failed", "canceled"].includes(status)) {
      try {
        db.insertMissedCall({
          $caller:   from,
          $call_sid: callSid,
          $status:   status === "no-answer" ? "gemist" : status,
          $duration: duration,
        });
        db.insertStat({ $event: "missed_call", $channel: CHANNEL, $meta: from || null });
        console.log(`[VoiceAgent] Missed call from ${from} — status: ${status}`);
      } catch (e) {
        console.error("[VoiceAgent] Failed to log missed call:", e.message);
      }
    }
    res.sendStatus(204);
  });

  // ── 2. WebSocket Server — Twilio Media Streams ──────────────────────────────
  const wss = new WS.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = url.parse(req.url || "");
    if (pathname !== "/api/twilio/stream") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (twilioWs, req) => {
    // Grab callSid from query string
    const qs      = new URLSearchParams((url.parse(req.url || "").query) || "");
    const callSid = qs.get("callSid") || "";
    let   streamSid   = null;
    let   fromNumber  = pendingCalls.get(callSid) || "";
    let   sessionId   = callSid || `va_${Date.now()}`;
    let   dgWs        = null;
    let   keepAlive   = null;

    const log = (msg) => {
      console.log(`[VoiceAgent:${sessionId}] ${msg}`);
      dbLog(sessionId, msg);
    };

    // ── Connect to Deepgram Voice Agent ───────────────────────────────────────
    function connectDG() {
      const key = process.env.DEEPGRAM_API_KEY;
      if (!key) {
        log("ERROR: DEEPGRAM_API_KEY is not set — cannot start voice agent");
        twilioWs.close();
        return;
      }

      dgWs = new WS(DG_URL, { headers: { Authorization: `Token ${key}` } });

      dgWs.on("open", () => {
        log("Deepgram Voice Agent connected — sending Settings");
        dgWs.send(JSON.stringify(buildSettings()));

        // Keep-alive every 5 s to prevent idle timeout
        keepAlive = setInterval(() => {
          if (dgWs.readyState === WS.OPEN) {
            dgWs.send(JSON.stringify({ type: "KeepAlive" }));
          }
        }, 5000);
      });

      // Messages from Deepgram: binary = audio,  text = JSON event
      dgWs.on("message", (data, isBinary) => {
        if (isBinary || Buffer.isBuffer(data)) {
          // ── Audio: forward to Twilio ────────────────────────────────────────
          if (twilioWs.readyState === WS.OPEN && streamSid) {
            const payload = (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("base64");
            twilioWs.send(JSON.stringify({
              event:     "media",
              streamSid: streamSid,
              media:     { payload },
            }));
          }
          return;
        }

        // ── JSON event ─────────────────────────────────────────────────────────
        const msg = safeJSON(data.toString("utf8"));
        if (!msg) return;

        switch (msg.type) {
          case "Welcome":
            log("Deepgram: Welcome received");
            break;

          case "SettingsApplied":
            log("Deepgram: Settings applied — agent ready");
            break;

          case "ConversationText":
            // Full transcript of what was said (role: "user" | "agent")
            if (msg.content) {
              const role = msg.role === "user" ? "user" : "agent";
              console.log(`[VoiceAgent transcript] ${role}: ${msg.content}`);
              dbTranscript(sessionId, role, msg.content, fromNumber);
            }
            break;

          case "UserStartedSpeaking":
            // Barge-in: caller started speaking while agent was talking
            log("Barge-in detected");
            break;

          case "AgentThinking":
            // LLM is processing — optional log
            break;

          case "Error":
            log(`Deepgram error: ${msg.message || JSON.stringify(msg)}`);
            break;

          default:
            // log(`Deepgram event: ${msg.type}`);
            break;
        }
      });

      dgWs.on("error", (e) => log(`Deepgram WS error: ${e.message}`));
      dgWs.on("close", (code) => {
        log(`Deepgram WS closed (code ${code})`);
        clearInterval(keepAlive);
      });
    }

    // ── Handle Twilio events ─────────────────────────────────────────────────
    twilioWs.on("message", (raw) => {
      const msg = safeJSON(raw.toString("utf8"));
      if (!msg || !msg.event) return;

      switch (msg.event) {
        case "connected":
          // Initial handshake — ignore
          break;

        case "start":
          streamSid  = msg.start?.streamSid || msg.streamSid || null;
          callSid    = msg.start?.callSid   || callSid;
          sessionId  = callSid || sessionId;
          // Try to get fromNumber if not already captured via webhook
          if (!fromNumber && pendingCalls.has(callSid)) {
            fromNumber = pendingCalls.get(callSid);
          }
          log(`Call started — from=${fromNumber || "?"} streamSid=${streamSid}`);
          db.insertStat?.({ $event: "voice_agent_call", $channel: CHANNEL, $meta: fromNumber || null });
          connectDG();
          break;

        case "media":
          // Inbound mulaw 8 kHz from Twilio → forward to Deepgram
          if (!dgWs || dgWs.readyState !== WS.OPEN) return;
          {
            const audio = Buffer.from(msg.media?.payload || "", "base64");
            try { dgWs.send(audio); } catch {}
          }
          break;

        case "mark":
          // Twilio mark events — no action needed
          break;

        case "stop":
          log("Call ended");
          cleanup();
          pendingCalls.delete(callSid);
          break;
      }
    });

    twilioWs.on("close", () => {
      log("Twilio WS closed");
      cleanup();
      pendingCalls.delete(callSid);
    });

    twilioWs.on("error", (e) => {
      try { log(`Twilio WS error: ${e.message}`); } catch {}
    });

    function cleanup() {
      clearInterval(keepAlive);
      try { if (dgWs) dgWs.close(); } catch {}
    }
  });

  console.log("📞 Voice Agent channel registered (Twilio + Deepgram Voice Agent)");
  console.log("   Webhook : POST /api/twilio/voice");
  console.log("   Stream  : WS   /api/twilio/stream");
}

module.exports = { register };
